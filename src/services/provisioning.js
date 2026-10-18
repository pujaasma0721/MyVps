"use strict";
/**
 * INSTANT provisioning pipeline (Region 2.1 + 2.2).
 *
 * The order lifecycle after POST /checkout:
 *   1. allocate IP+PORT transactionally (SERVER_FULL -> abort BEFORE any clone)
 *   2. create Order (PENDING_PAYMENT) + Invoice rows
 *   3. clone template 100 -> resize scsi0 -> cloud-init inject -> start
 *   4. iptables DNAT {port} -> {ip}:22 + iptables-save
 *   5. nginx vhost {order_id}.{MAIN_DOMAIN} proxy_pass -> http://{ip}:80
 *      (wildcard cert *.MAIN_DOMAIN — never touches certbot at checkout)
 *   6. email credentials via Nodemailer
 *
 * Any failure after step 2 triggers the nuclear rollback so no half-built
 * VPS lingers. Physical-RAM guard runs first against /nodes/pve/status.
 */
const crypto = require("crypto");
const config = require("../config");
const C = require("../config/constants");
const proxmox = require("../lib/proxmox");
const shell = require("../lib/shell");
const emailer = require("../lib/email");
const prisma = require("../lib/prisma");
const { allocateIpAndPort, releaseIpAndPort, ServerFullError } = require("./resources");
const { nucleusRollback } = require("./nucleus");

/** Random but safe-to-type password for cloud-init (mix of alphanumerics). */
function generateVmPassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789#$%*";
  const bytes = crypto.randomBytes(18);
  let pw = "";
  bytes.forEach((b) => (pw += alphabet[b % alphabet.length]));
  return pw;
}

/**
 * Physical RAM check BEFORE any provisioning (Region 2.2 bullet 1).
 * @throws ServerFullError if memory.free < package ram
 */
async function assertHostHasFreeRam(ramMb) {
  const st = await proxmox.nodeStatus();
  const freeBytes = st?.memory?.free ?? 0;
  if (freeBytes < ramMb * 1024 * 1024) {
    throw new ServerFullError(
      `SERVER_FULL: free host RAM ${Math.floor(freeBytes / 1024 ** 3)}GB < requested ${ramMb}MB`
    );
  }
  return st;
}

/**
 * Instant checkout. Returns the created { order, vps }.
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.packageId
 * @param {number} p.months
 * @param {string|null} p.customDomain
 * @param {string|null} p.proofImageRel  uploaded QRIS proof path (installed by multer)
 */
async function provisionInstantOrder({ userId, packageId, months, customDomain, proofImageRel }) {
  const pkg = await prisma.package.findUnique({ where: { id: packageId } });
  if (!pkg || !pkg.isActive) throw new Error("PACKAGE_NOT_FOUND");

  await assertHostHasFreeRam(pkg.ramMb);

  const orderId = crypto.randomUUID();
  const amount = pkg.priceMonthly.mul(months);

  // -- Steps 1+2: resource allocation + DB rows (atomically reserved slots)
  const { ip, port } = await allocateIpAndPort(orderId);
  const vmPassword = generateVmPassword();
  const vmid = await proxmox.nextVmId();

  let order;
  try {
    order = await prisma.order.create({
      data: {
        id: orderId,
        userId,
        packageId,
        months: parseInt(months, 10) || 1,
        amount,
        status: "PENDING_PAYMENT",
        customDomain: customDomain || null,
        proofImage: proofImageRel || null,
        vps: {
          create: { vmid, ipInternal: ip, portCustom: port, osPassword: vmPassword },
        },
        invoice: {
          create: { amount, note: `${pkg.name} x ${months} bln` },
        },
      },
      include: { vps: true, package: true, user: true },
    });
  } catch (err) {
    await releaseIpAndPort(orderId);
    throw err;
  }

  // -- Steps 3..6 outside the DB transaction (long-running shell/API work)
  try {
    // 3. clone -> resize -> package spec (vCPU/RAM) -> cloud-init -> start
    await proxmox.cloneTemplate({ newId: vmid, name: `vps-${orderId}` }); // full=1
    await proxmox.resizeDisk(vmid, "scsi0", pkg.diskGb);
    // clone inherits template spec (2c/2GB) — force the purchased package size
    await proxmox.applyPackageSpec(vmid, { vcpu: pkg.vcpu, ramMb: pkg.ramMb });
    await proxmox.injectCloudInit(vmid, {
      ciuser: C.VM_USER,               // ubuntu
      cipassword: vmPassword,
      ipconfig0: `ip=${ip}/${C.NETMASK_CIDR},gw=${C.GATEWAY}`, // attached to C.BRIDGE (vmbr1) via template config
    });
    await proxmox.startVm(vmid);

    // 4. NAT: external pool port -> internal VPS SSH :22
    await shell.iptablesAddRule({ portCustom: port, ipInternal: ip, orderId });

    // 5. default subdomain vhost (spec uses wildcard cert; NO certbot here)
    const subdomain = `${orderId}.${config.mainDomain}`;
    await shell.nginxAddDomain(subdomain, ip);
    // custom domain vhosts are only added when the user wires them up post-purchase

    // 6. credential email
    await sendCredentialsEmail(order, { publicIp: config.publicIp, port, subdomain, vmPassword, pkg });

    await prisma.orderVps.update({
      where: { orderId },
      data: { vmStatus: "running" },
    });
    return { order, vps: { ip, port, vmid, subdomain, password: vmPassword } };
  } catch (err) {
    console.error("[provisioning] failed mid-pipeline, running nuclear rollback:", err.message);
    // Total safety: remove whatever got built; re-throw a user-safe summary.
    try { await nucleusRollback(orderId, "PENDING_PAYMENT"); } catch (_e) { /* already noisy */ }
    err.pipelineOnly = true;
    err.userMessage = "Provisioning gagal di tengah proses. Semua resource dikembalikan — silakan coba lagi.";
    throw err;
  }
}

async function sendCredentialsEmail(order, { publicIp, port, subdomain, vmPassword, pkg }) {
  const text =
    `Terima kasih telah membeli ${pkg.name} di MYVPS.\n\n` +
    `Detail VPS Anda:\n` +
    `  - IP Publik (NAT): ${publicIp}\n` +
    `  - Port SSH Kustom: ${port}\n` +
    `  - Username: ${C.VM_USER}\n` +
    `  - Password : ${vmPassword}\n\n` +
    `Subdomain default: ${subdomain}\n` +
    `SSH: ssh ${C.VM_USER}@${publicIp} -p ${port}\n\n` +
    `PENTING: ${C.WARNING_24H_TEXT}\n`;
  const html =
    `<p>Terima kasih telah membeli <b>${pkg.name}</b> di MYVPS.</p>` +
    `<ul><li>IP Publik: <b>${publicIp}</b></li>` +
    `<li>Port SSH Kustom: <b>${port}</b></li>` +
    `<li>Username: <b>${C.VM_USER}</b></li>` +
    `<li>Password: <b>${vmPassword}</b></li></ul>` +
    `<p>Subdomain default: <code>${subdomain}</code></p>` +
    `<p><b>PENTING:</b> ${C.WARNING_24H_TEXT}</p>`;
  await emailer.sendMail({ to: order.user.email, subject: `Aktivasi VPS — ${order.id.slice(0, 8).toUpperCase()}`, text, html });
}

module.exports = { provisionInstantOrder, assertHostHasFreeRam, generateVmPassword };
