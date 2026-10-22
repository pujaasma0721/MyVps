"use strict";
/**
 * Subscription expiry (Region: masa aktif VPS).
 *
 * - expiresAt is set when the admin VERIFIES the payment: verifiedAt + months.
 * - Admin can extend (renewal): extendOrder pushes the deadline further.
 * - sweepExpiredOrders(): any ACTIVE order whose expiresAt passed by more
 *   than EXPIRY_AUTO_DELETE_HOURS (default 24h) gets the SAME nuclear
 *   rollback used for rejected proofs — VM destroyed, IP/port freed, slots
 *   returned to the pool, order marked EXPIRED.
 *
 * Sweep is idempotent: a re-run sees nothing left to expire.
 */
const prisma = require("../lib/prisma");
const C = require("../config/constants");
const { nucleusRollback } = require("./nucleus");
const { sendTelegram } = require("../lib/telegram");

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Compute the expiry deadline from a verification timestamp. */
function computeExpiry(verifiedAt, months) {
  return addMonths(verifiedAt, Math.max(1, Math.floor(months)));
}

/**
 * Renew an order by `months`. The extension starts from the LATER of
 * (now, current expiresAt) so early renewal never shortens the term.
 */
async function extendOrder(orderId, months) {
  const n = Math.max(1, Math.floor(Number(months) || 1));
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { vps: true } });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.status !== "ACTIVE") throw new Error("Hanya order ACTIVE yang bisa diperpanjang.");

  const base = order.expiresAt && order.expiresAt > new Date() ? order.expiresAt : new Date();
  const next = computeExpiry(base, n);
  await prisma.order.update({ where: { id: orderId }, data: { expiresAt: next } });
  return { orderId, expiresAt: next, extendedMonths: n };
}

/**
 * Find ACTIVE orders expired more than the grace window and destroy them.
 * Telegram notification is fire-and-forget per affected order.
 */
async function sweepExpiredOrders() {
  const cutoff = new Date(Date.now() - C.EXPIRY_AUTO_DELETE_HOURS * 3600 * 1000);
  const due = await prisma.order.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: cutoff } },
    include: { user: { select: { fullName: true, email: true } }, package: true, vps: true },
  });
  const results = [];
  for (const o of due) {
    const reason = `Masa aktif habis (${new Date(o.expiresAt).toLocaleString("id-ID")}) — VM dihapus otomatis 1 hari setelah expired tanpa perpanjangan.`;
    await sendTelegram(
      `⏰ <b>VM EXPIRED — dihapus otomatis</b>\n\n` +
      `Order: <code>${o.id.slice(0, 8)}</code>\n` +
      `Paket: ${o.package.name}\n` +
      `Pemilik: ${o.user.fullName} (${o.user.email})\n` +
      `Expired: ${new Date(o.expiresAt).toLocaleString("id-ID")}\n` +
      (o.vps ? `VMID: ${o.vps.vmid} · IP: ${o.vps.ipInternal} · Port: ${o.vps.portCustom}\n` : "") +
      `Status order: <b>EXPIRED</b> (rollback permanen).`, 
    ).catch(() => {});
    const res = await nucleusRollback(o.id, "EXPIRED", reason);
    results.push({ orderId: o.id, vmid: o.vps ? o.vps.vmid : null, ok: res.ok });
  }
  if (due.length) console.log(`[expiry] swept ${due.length} expired order(s)`);
  return results;
}

module.exports = { computeExpiry, extendOrder, sweepExpiredOrders, addMonths };
