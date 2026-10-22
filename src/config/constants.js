/**
 * Fixed architecture constants — Region 1 of the spec.
 * Kept in ONE place so nothing in the codebase assumes another value.
 */
module.exports = {
  PROXMOX_NODE: "pve",
  TEMPLATE_VM_ID: 100,

  // Internal network pool (Netmask /24 — Gateway 10.0.0.1)
  BRIDGE: process.env.PROXMOX_BRIDGE || "vmbr1",
  NETMASK: "255.255.255.0",
  NETMASK_CIDR: "24",
  GATEWAY: "10.0.0.1",
  IP_START: "10.0.0.100",
  IP_END: "10.0.0.250",

  // Custom external SSH port pool
  SSH_PORT_START: 10100,
  SSH_PORT_END: 10250,

  // SSH user inside every KVM VPS (cloud-init). LXC container root login uses
  // LXC_USER below (PVE create hook sets the ROOT password at create time).
  VM_USER: "ubuntu",
  LXC_USER: "root",

  // Task polling
  TASK_POLL_INTERVAL_MS: 5000,
  TASK_POLL_TIMEOUT_MS: 10 * 60 * 1000, // 10 minutes hard cap

  // Payment grace window
  PAYMENT_GRACE_HOURS: 24,

  // Subscription expiry: an ACTIVE VM is destroyed automatically this many
  // hours AFTER its expiresAt passes, unless the admin extends it (renewal).
  EXPIRY_AUTO_DELETE_HOURS: 24,

  // Safe-capacity guard ("no unsafe sharing" rule at checkout):
  //   - RAM reserve the Proxmox host must ALWAYS keep free (host services,
  //     ZFS/PVE overhead) on top of any purchased package RAM.
  //   - CPU reserve the node must keep free of committed vCPU (no overcommit).
  //   - KVM committed RAM/cores must also fit the LIVE free-RAM/cores check.
  HOST_RAM_RESERVE_MB: 4096,
  HOST_CORE_RESERVE: 2,

  // LXC tier shared-kernel guard. Containers do not hard-reserve RAM the way
  // KVM does, so a separate BUDGET applies: sum of committed LXC package RAM
  // may never exceed this, and committed LXC vcpu (oversubscribed 1.5x of the
  // physical count configured on the node; adjusted to 40 logical for safety
  // on smaller hosts via the lower bound) may never exceed this core budget.
  HOST_LXC_RAM_BUDGET_MB: 40960,
  HOST_LXC_CORE_BUDGET: 60,
  HOST_LXC_MIN_RESERVE_MB: 2048, // live free-RAM sanity floor for an LXC order

  // Network protections (Region: pelindung bandwidth & anti-abuse)
  //   LXC_MAX_NET_MBPS: tc shaping max on every LXC veth (net0 rate=).
  //   FORWARDED_PORT_POOL covers SSH DNAT; FORWARD-chain rules live on the
  //   host (see DEPLOYMENT section "Proteksi Network").
  LXC_MAX_NET_MBPS: 50,
  SMTP_BLOCK_PORTS: [25], // outbound blocked for ALL guests (KVM + LXC)
  CONN_LIMIT_PER_GUEST: 250, // concurrent TCP conns per guest IP (connlimit)

  // Orders rejected/invalid proof wording shown in user banner
  WARNING_24H_TEXT:
    "VPS Anda langsung aktif. Jika dalam 24 jam bukti transfer tidak valid/palsu, sistem akan melakukan penghapusan total secara permanen!",
};
