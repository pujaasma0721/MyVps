"use strict";
/**
 * SAFE-CAPACITY GUARD — "minimal sharing resource aman" checkout rule.
 *
 * A checkout may only proceed when the host can host the package WITHOUT
 * sharing resources unsafely:
 *   - RAM   : free host RAM must fit pkg.ramMb PLUS a fixed host reserve
 *             (no ballooning/overcommit luck — real free RAM from the node API)
 *   - vCPU  : committed vCPU across all live VPS (ACTIVE + PENDING_PAYMENT,
 *             both have a running VM) + pkg.vcpu must stay under maxcpu
 *             minus a small host-reserve  →  no vCPU overcommit
 *   - pools : at least one AVAILABLE IP and one AVAILABLE SSH port
 *
 * This is a preflight: it runs on GET /checkout (so a sold-out package is
 * never even offered) and again on POST /checkout right before allocation,
 * where allocateIpAndPort still enforces the final transactional claim.
 */
const prisma = require("../lib/prisma");
const proxmox = require("../lib/proxmox");
const C = require("../config/constants");

class PackageUnavailableError extends Error {
  constructor(failures) {
    super("PACKAGE_UNAVAILABLE: " + failures.map((f) => f.code).join(","));
    this.name = "PackageUnavailableError";
    this.failures = failures;
  }
}

/**
 * Snapshot of every capacity dimension checked at checkout time.
 * KVM budget = live free RAM/cores dari node API (no overcommit).
 * LXC budget = committed sums dari DB (shared kernel, see constants).
 * @returns {Promise<{freeRamMb:number, freeCores:number, ip:number, port:number,
 *                    committedCores, maxCores, committedLxcRamMb, committedLxcCores}>}
 */
async function capacitySnapshot() {
  const st = await proxmox.nodeStatus();
  // lampiran API PVE di build ini tidak punya node "maxcpu" — jumlah logical
  // CPU hidup di node.cpuinfo.cpus (fallback lama tetap disertakan)
  const maxCores = st?.cpuinfo?.cpus ?? st?.maxcpu ?? 0;
  const freeRamMb = Math.floor((st?.memory?.free ?? 0) / (1024 * 1024));

  const [committedOrders, ipAvailable, portAvailable] = await Promise.all([
    // both ACTIVE and PENDING_PAYMENT orders have a REAL running guest
    prisma.order.findMany({
      where: { status: { in: ["ACTIVE", "PENDING_PAYMENT"] }, vps: { isNot: null } },
      select: { package: { select: { kind: true, vcpu: true, ramMb: true } } },
    }),
    prisma.availableIp.count({ where: { status: "AVAILABLE" } }),
    prisma.availablePort.count({ where: { status: "AVAILABLE" } }),
  ]);

  const kvm = committedOrders.filter((o) => (o.package?.kind ?? "KVM") === "KVM");
  const lxc = committedOrders.filter((o) => o.package?.kind === "LXC");

  return {
    freeRamMb,
    freeCores: Math.max(0, maxCores - C.HOST_CORE_RESERVE - kvm.reduce((a, o) => a + (o.package?.vcpu ?? 0), 0)),
    committedRamMb: kvm.reduce((a, o) => a + (o.package?.ramMb ?? 0), 0),
    committedCores: kvm.reduce((a, o) => a + (o.package?.vcpu ?? 0), 0),
    committedLxcRamMb: lxc.reduce((a, o) => a + (o.package?.ramMb ?? 0), 0),
    committedLxcCores: lxc.reduce((a, o) => a + (o.package?.vcpu ?? 0), 0),
    ip: ipAvailable,
    port: portAvailable,
    maxCores,
  };
}

/**
 * @param {object} pkg a Package row (kind, vcpu, ramMb) — or any object sharing them
 * @param {object} [snap] optional pre-fetched snapshot (tests)
 * @returns {Promise<{ok:boolean, failures:Array<{code:string,message:string}>, snapshot:object}>}
 */
async function checkPackageCapacity(pkg, snap) {
  const s = snap || (await capacitySnapshot());
  const failures = [];
  const kind = pkg.kind === "LXC" ? "LXC" : "KVM";

  if (kind === "KVM") {
    if (s.freeRamMb < pkg.ramMb + C.HOST_RAM_RESERVE_MB) {
      failures.push({
        code: "RAM",
        message: `free host RAM ${s.freeRamMb}MB < requested ${pkg.ramMb}MB + reserve ${C.HOST_RAM_RESERVE_MB}MB`,
      });
    }
    if (s.freeCores < pkg.vcpu) {
      failures.push({
        code: "CPU",
        message: `uncommitted cores ${s.freeCores}/${s.maxCores} < requested vCPU ${pkg.vcpu}`,
      });
    }
  } else {
    // Shared-kernel tier: separate budget, bucket does NOT compete with KVM
    if (s.committedLxcRamMb + pkg.ramMb > C.HOST_LXC_RAM_BUDGET_MB) {
      failures.push({
        code: "RAM_LXC",
        message: `LXC RAM budget ${C.HOST_LXC_RAM_BUDGET_MB}MB exceeded: committed ${s.committedLxcRamMb}MB + requested ${pkg.ramMb}MB`,
      });
    } else if (s.freeRamMb < C.HOST_LXC_MIN_RESERVE_MB) {
      failures.push({
        code: "RAM",
        message: `live free host RAM ${s.freeRamMb}MB is below the sanity floor ${C.HOST_LXC_MIN_RESERVE_MB}MB`,
      });
    }
    if (s.committedLxcCores + pkg.vcpu > C.HOST_LXC_CORE_BUDGET) {
      failures.push({
        code: "CPU_LXC",
        message: `LXC core budget ${C.HOST_LXC_CORE_BUDGET} exceeded: committed ${s.committedLxcCores} + requested ${pkg.vcpu}`,
      });
    }
  }

  // Pools are shared by both tiers
  if (s.ip < 1) failures.push({ code: "IP_POOL", message: "no AVAILABLE internal IP left" });
  if (s.port < 1) failures.push({ code: "PORT_POOL", message: "no AVAILABLE SSH port left" });

  return { ok: failures.length === 0, failures, snapshot: s };
}

/** Throwing variant for the provisioning hot path. */
async function assertPackageCapacity(pkg, snap) {
  const r = await checkPackageCapacity(pkg, snap);
  if (!r.ok) throw new PackageUnavailableError(r.failures);
  return r;
}

module.exports = { PackageUnavailableError, capacitySnapshot, checkPackageCapacity, assertPackageCapacity };
