"use strict";
/**
 * Monitoring service (Region 3.1).
 * Shapes Proxmox data into dashboard-ready numbers (GB, %, human uptime).
 */
const proxmox = require("../lib/proxmox");
const prisma = require("../lib/prisma");
const config = require("../config");
const NODE = () => config.proxmox.node;

function gb(bytes) {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

function humanUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}j ${m}m`;
}

/** Host OS health: CPU %, RAM GB, SSD, uptime. */
async function hostHealth() {
  const st = await proxmox.nodeStatus();
  return {
    cpuPercent: Math.round((st.cpu ?? 0) * 1000) / 10,
    ram: { usedGb: gb(st.memory?.used || 0), totalGb: gb(st.memory?.total || 0), freeGb: gb(st.memory?.free || 0) },
    ramPercent: st.memory ? Math.round((st.memory.used / st.memory.total) * 1000) / 10 : 0,
    ssd: { usedGb: gb(st.rootfs?.used || 0), totalGb: gb(st.rootfs?.total || 0), freeGb: gb(st.rootfs?.free || 0) },
    ssdPercent: st.rootfs ? Math.round((st.rootfs.used / st.rootfs.total) * 1000) / 10 : 0,
    uptime: humanUptime(st.uptime || 0),
    uptimeSeconds: st.uptime || 0,
  };
}

/** All customer VMs with real-time running/stopped status. */
async function customerVmsLive() {
  const rows = await prisma.orderVps.findMany({
    include: {
      order: {
        include: {
          user: { select: { fullName: true, email: true } },
          package: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const live = await Promise.all(
    rows.map(async (r) => {
      const kind = r.order.package?.kind === "LXC" ? "LXC" : "KVM";
      let status = "unknown";
      let metrics = null;
      try {
        const st = await proxmox.guestStatus(kind, r.vmid);
        status = st ? st.status : "missing";
        // Live utilization (only meaningful while running)
        if (st && status === "running") {
          metrics = {
            cpuPercent: Math.round((st.cpu ?? 0) * 1000) / 10,
            cpuCoresAlloc: st.cpus ?? null,
            ramUsedGb: gb(st.mem || 0),
            ramTotalGb: gb(st.maxmem || 0),
            ramPercent: st.maxmem ? Math.round(((st.mem || 0) / st.maxmem) * 1000) / 10 : 0,
            diskUsedGb: gb(st.disk || 0),
            diskTotalGb: gb(st.maxdisk || 0),
            diskPercent: st.maxdisk ? Math.round(((st.disk || 0) / st.maxdisk) * 1000) / 10 : 0,
            uptime: humanUptime(st.uptime || 0),
          };
        }
      } catch {
        status = "unknown";
      }
      // persist for the table cache too
      if (status && status !== r.vmStatus) {
        prisma.orderVps.update({ where: { orderId: r.orderId }, data: { vmStatus: status } }).catch(() => {});
      }
      return {
        orderId: r.orderId,
        vmid: r.vmid,
        kind,
        name: r.order.package.name,
        owner: r.order.user.fullName,
        email: r.order.user.email,
        ipInternal: r.ipInternal,
        portCustom: r.portCustom,
        vmStatus: status,
        orderStatus: r.order.status,
        createdAt: r.order.createdAt,
        expiresAt: r.order.expiresAt,
        metrics,
        spec: {
          vcpu: r.order.package.vcpu,
          ramGb: gb((r.order.package.ramMb || 0) * 1024 * 1024),
          diskGb: r.order.package.diskGb,
        },
      };
    })
  );
  return live;
}
const fs = require("fs");
const { execFile } = require("child_process");

/**
 * Read host thermals without external tools:
 *  - /sys/class/thermal/thermal_zone* (CPU package, x86_pkg_temp, acpitz)
 *  - k10temp/coretemp hwmon if exposed
 * Returns [{label, tempC}] sorted hottest-first, or [] when unknown.
 */
function readThermals() {
  const out = [];
  try {
    const zones = fs.readdirSync("/sys/class/thermal").filter((d) => d.startsWith("thermal_zone"));
    for (const z of zones) {
      try {
        const type = fs.readFileSync(`/sys/class/thermal/${z}/type`, "utf8").trim();
        const milli = parseInt(fs.readFileSync(`/sys/class/thermal/${z}/temp`, "utf8").trim(), 10);
        if (Number.isFinite(milli) && milli > -40000 && milli < 150000) {
          out.push({ label: type, tempC: Math.round((milli / 1000) * 10) / 10 });
        }
      } catch { /* ignore per-zone */ }
    }
  } catch { /* sysfs not present */ }
  // HWmon sensors (coretemp/k10temp etc.) when thermal zones are missing
  try {
    const hws = fs.readdirSync("/sys/class/hwmon");
    for (const hw of hws) {
      try {
        const name = fs.readFileSync(`/sys/class/hwmon/${hw}/name`, "utf8").trim();
        const temps = fs.readdirSync(`/sys/class/hwmon/${hw}`).filter((f) => /^temp\d+_input$/.test(f));
        let idx = 1;
        for (const t of temps) {
          try {
            const milli = parseInt(fs.readFileSync(`/sys/class/hwmon/${hw}/${t}`, "utf8").trim(), 10);
            let label = `sensor ${idx++}`;
            try { label = fs.readFileSync(`/sys/class/hwmon/${hw}/${t.replace("_input", "_label")}`, "utf8").trim(); } catch { /* default */ }
            if (Number.isFinite(milli) && milli > -40000 && milli < 150000) {
              out.push({ label: `${name} ${label}`, tempC: Math.round((milli / 1000) * 10) / 10 });
            }
          } catch { /* ignore per-sensor */ }
        }
      } catch { /* ignore per-hwmon */ }
    }
  } catch { /* no hwmon */ }
  return out.sort((a, b) => b.tempC - a.tempC);
}

/** Read load average (1/5/15 min) straight from the host. */
function readLoad() {
  try {
    const l = fs.readFileSync("/proc/loadavg", "utf8").trim().split("\s+");
    return { l1: parseFloat(l[0]) || 0, l5: parseFloat(l[1]) || 0, l15: parseFloat(l[2]) || 0 };
  } catch { return { l1: 0, l5: 0, l15: 0 }; }
}

/**
 * Full admin health snapshot — one round trip for the auto-refresh dashboard.
 * Includes host nodeStatus, thermals, load, all-VM aggregate storage and
 * per-VM CPU/mem allocated (customer VMs only, resolves owner via DB).
 */
async function adminHealth() {
  const st = await proxmox.nodeStatus();
  const customerVms = await customerVmsLive();

  // Visitor VMs on the node (template + others via Proxmox API, not DB)
  let qemus = [];
  try { qemus = await proxmox.request("GET", `/nodes/${NODE()}/qemu`) || []; } catch { /* ignore */ }
  let cts = [];
  try { cts = await proxmox.request("GET", `/nodes/${NODE()}/lxc`) || []; } catch { /* ignore */ }
  const runningVms = qemus.filter((q) => q.status === "running");

  // Guest storage aggregate: every VM disk visible on the node
  // rootfs of host +  sum of VM disk usage via API (maxdisk/disk)
  let vmDiskUsed = 0, vmDiskTotal = 0;
  qemus.forEach((q) => { vmDiskTotal += q.maxdisk || 0; vmDiskUsed += (q.disk || 0); });

  const thermals = readThermals();
  const load = readLoad();
  // Hitsung core dari API PVE (bukan dari process.env/os agar tidak salah bila service dipindah mesin)
  const cores = (st.cpuinfo && Number(st.cpuinfo.cpus)) || require("os").cpus().length;
  const loadAvgFrom = st.loadavg && st.loadavg.length ? { l1: st.loadavg[0], l5: st.loadavg[1], l15: st.loadavg[2] } : load;

  return {
    node: st.node || NODE(),
    pveVersion: st.pveversion || "",
    cpu: {
      percent: Math.round((st.cpu ?? 0) * 1000) / 10,
      cores,
      load: loadAvgFrom,
    },
    ram: {
      usedGb: gb(st.memory?.used || 0),
      totalGb: gb(st.memory?.total || 0),
      freeGb: gb(st.memory?.free || 0),
      percent: st.memory ? Math.round((st.memory.used / st.memory.total) * 1000) / 10 : 0,
      swapUsedGb: gb(st.swap?.used || 0),
      swapTotalGb: gb(st.swap?.total || 0),
    },
    rootfs: {
      usedGb: gb(st.rootfs?.used || 0),
      totalGb: gb(st.rootfs?.total || 0),
      freeGb: gb(st.rootfs?.free || 0),
      percent: st.rootfs ? Math.round((st.rootfs.used / st.rootfs.total) * 1000) / 10 : 0,
    },
    vmsDisk: {
      usedGb: gb(vmDiskUsed),
      totalGb: gb(vmDiskTotal),
      availableGb: gb(Math.max(0, vmDiskTotal - vmDiskUsed)),
      percent: vmDiskTotal ? Math.round((vmDiskUsed / vmDiskTotal) * 1000) / 10 : 0,
    },
    thermals,
    hottestC: thermals.length ? thermals[0].tempC : null,
    uptime: humanUptime(st.uptime || 0),
    uptimeSeconds: st.uptime || 0,
    kvms: {
      running: runningVms.length,
      total: qemus.length,
    },
    lxcs: {
      running: cts.filter((c) => c.status === "running").length,
      total: cts.length,
    },
    customerVms: customerVms.map((v) => ({
      vmid: v.vmid,
      name: v.name,
      owner: v.owner,
      status: v.vmStatus,
      orderStatus: v.orderStatus,
      metrics: v.metrics || null,
      spec: v.spec || null,
    })),
    cpuLoadAvg: load.l5,
  };
}

module.exports = { hostHealth, customerVmsLive, humanUptime, gb, adminHealth, readThermals };
