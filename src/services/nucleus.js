"use strict";
/**
 * NUCLEAR ROLLBACK — Region 3.2 "CANCEL/REJECT PERMANENT".
 *
 * Every component cleanup is wrapped in its OWN isolated try-catch so that a
 * single missing/failing component can never stop the destruction of the
 * remaining ones. Order of execution per spec:
 *   1. stop VM (POST status/stop, poll UPID) then DELETE /qemu/{vmid}
 *   2. iptables -D PREROUTING (full-args match) + iptables-save (errors ignored)
 *   3. certbot delete + nginx vhost removal (custom domain) OR plain vhost
 *      removal (default subdomain) + nginx -s reload
 *   4. DB release: order -> REJECTED, IP + PORT slots -> AVAILABLE
 *
 * @param {string} orderId
 * @param {"REJECTED"|"EXPIRED"} finalStatus
 * @param {string|null} rejectReason
 */
const prisma = require("../lib/prisma");
const config = require("../config");
const proxmox = require("../lib/proxmox");
const shell = require("../lib/shell");
const { releaseIpAndPort } = require("./resources");

async function nucleusRollback(orderId, finalStatus = "REJECTED", rejectReason = null) {
  const stepsLog = [];
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { vps: true, package: true },
  });
  if (!order) throw new Error(`Order ${orderId} not found`);

  // ---- STEP 1: shutdown & destroy guest (KVM qemu or LXC container) ------
  const kind = order.package?.kind === "LXC" ? "LXC" : "KVM";
  if (order.vps) {
    try {
      await proxmox.stopGuest(kind, order.vps.vmid); // task-stop + UPID poll
      stepsLog.push({ step: "guest_stop", ok: true, vmid: order.vps.vmid, kind });
    } catch (err) {
      stepsLog.push({ step: "guest_stop", ok: false, error: err.message });
    }
    try {
      await proxmox.destroyGuest(kind, order.vps.vmid); // DELETE /qemu|/lxc/{vmid}
      stepsLog.push({ step: "guest_destroy", ok: true, vmid: order.vps.vmid, kind });
    } catch (err) {
      stepsLog.push({ step: "guest_destroy", ok: false, error: err.message });
    }
  }

  // ---- STEP 2: explicit network cleanup ---------------------------------
  if (order.vps) {
    try {
      await shell.iptablesRemoveRule({
        portCustom: order.vps.portCustom,
        ipInternal: order.vps.ipInternal,
        orderId,
      });
      stepsLog.push({ step: "iptables_remove", ok: true });
    } catch (err) {
      stepsLog.push({ step: "iptables_remove", ok: false, error: err.message });
    }
  }

  // ---- STEP 3: web server & SSL cleanup ---------------------------------
  try {
    if (order.customDomain) {
      await shell.certbotDelete(order.customDomain);
      await shell.nginxRemoveDomain(order.customDomain);
      stepsLog.push({ step: "web_ssl_custom", ok: true, domain: order.customDomain });
    } else {
      // default subdomain conf file: just delete it (no certbot involved)
      const subdomain = `${orderId}.${config.mainDomain}`;
      await shell.nginxRemoveDomain(subdomain);
      stepsLog.push({ step: "web_ssl_subdomain", ok: true, subdomain });
    }
  } catch (err) {
    stepsLog.push({ step: "web_ssl", ok: false, error: err.message });
  }

  // ---- STEP 4: database state release ------------------------------------
  try {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: finalStatus, rejectReason },
      include: {},
    });
    await prisma.invoice.updateMany({
      where: { orderId },
      data: { status: -1, verifiedAt: finalStatus ? new Date() : null },
    });
  } catch (err) {
    stepsLog.push({ step: "db_order_status", ok: false, error: err.message });
  }
  try {
    await prisma.orderVps.deleteMany({ where: { orderId } }); // removes FK refs so release works
    await releaseIpAndPort(orderId);                          // slots -> AVAILABLE
    stepsLog.push({ step: "db_release_slots", ok: true });
  } catch (err) {
    stepsLog.push({ step: "db_release_slots", ok: false, error: err.message });
  }

  const failed = stepsLog.filter((s) => !s.ok);
  console.log(`[nucleus] ${orderId} done; ${stepsLog.length} steps, ${failed.length} failed`,
    failed.length ? JSON.stringify(failed) : "");
  return { stepsLog, ok: failed.length === 0 };
}

module.exports = { nucleusRollback };
