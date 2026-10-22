"use strict";
/**
 * Financial service: verify a QRIS proof as valid.
 * Books MonthlyRevenueItem keyed on {orderId, monthKey of verifiedAt} —
 * unique([orderId]) makes double-verification a no-op.
 */
const prisma = require("../lib/prisma");
const { computeExpiry } = require("./expiry");

function monthKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function verifyInvoice(orderId, adminUserId, valid) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { invoice: true },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");

  if (!valid) {
    await prisma.invoice.updateMany({
      where: { orderId },
      data: { status: -1, verifiedBy: adminUserId, verifiedAt: new Date() },
    });
    return { order, status: -1 };
  }

  const now = new Date();
  await prisma.invoice.update({
    where: { orderId },
    data: { status: 1, verifiedAt: now, verifiedBy: adminUserId },
  });
  // status flip only if not already ACTIVE
  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: order.status === "PENDING_PAYMENT" ? "ACTIVE" : order.status,
      verifiedAt: now,
      // First activation starts the subscription clock: verifiedAt + months.
      ...(order.status === "PENDING_PAYMENT"
        ? { expiresAt: computeExpiry(now, order.months) }
        : {}),
    },
  });
  await prisma.monthlyRevenueItem.upsert({
    where: { orderId },
    create: { orderId, amount: order.amount, monthKey: monthKey(now) },
    update: { amount: order.amount, monthKey: monthKey(now) },
  });
  return { order, status: 1 };
}

module.exports = { verifyInvoice };
