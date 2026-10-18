"use strict";
/**
 * Monitoring service (Region 3.1).
 * Shapes Proxmox data into dashboard-ready numbers (GB, %, human uptime).
 */
const proxmox = require("../lib/proxmox");
const prisma = require("../lib/prisma");

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
      let status = "unknown";
      try {
        const st = await proxmox.vmStatus(r.vmid);
        status = st ? st.status : "missing";
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
        name: r.order.package.name,
        owner: r.order.user.fullName,
        email: r.order.user.email,
        ipInternal: r.ipInternal,
        portCustom: r.portCustom,
        vmStatus: status,
        orderStatus: r.order.status,
        createdAt: r.order.createdAt,
      };
    })
  );
  return live;
}

module.exports = { hostHealth, customerVmsLive, humanUptime, gb };
