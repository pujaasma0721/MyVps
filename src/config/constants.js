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

  // SSH user inside every VPS (cloud-init)
  VM_USER: "ubuntu",

  // Internal bridge for VPS traffic (set in .env: PROXMOX_BRIDGE)
  BRIDGE: process.env.PROXMOX_BRIDGE || "vmbr1",

  // Task polling
  TASK_POLL_INTERVAL_MS: 5000,
  TASK_POLL_TIMEOUT_MS: 10 * 60 * 1000, // 10 minutes hard cap

  // Payment grace window
  PAYMENT_GRACE_HOURS: 24,

  // Orders rejected/invalid proof wording shown in user banner
  WARNING_24H_TEXT:
    "VPS Anda langsung aktif. Jika dalam 24 jam bukti transfer tidak valid/palsu, sistem akan melakukan penghapusan total secara permanen!",
};
