const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const PAST = new Date(Date.now() - 2 * 86400000);
(async () => {
  const pk = await p.package.findFirst({ orderBy: { priceMonthly: "asc" } });
  const u = await p.user.upsert({
    where: { email: "_expiry-sweep-test@m.y" },
    update: {},
    create: { fullName: "_SWEEP_TEST", email: "_expiry-sweep-test@m.y", passwordHash: "x" },
  });
  const o = await p.order.create({
    data: { id: "_sweeptest0001", userId: u.id, packageId: pk.id, status: "ACTIVE", months: 1, amount: pk.priceMonthly, expiresAt: PAST },
  });
  console.log("CREATED expiresAt=", o.expiresAt);
  const { sweepExpiredOrders } = require("./src/services/expiry");
  const res = await sweepExpiredOrders();
  console.log("SWEEP_RESULT", JSON.stringify(res.map((r) => ({ orderId: r.orderId.slice(0, 9), ok: r.ok, vmid: r.vmid }))));
  const after = await p.order.findUnique({ where: { id: o.id } });
  console.log("AFTER status=", after.status, "| rejectReason=", after.rejectReason);
})()
  .catch((e) => { console.error("TEST_FAIL", e.message); process.exit(1); })
  .finally(() => p.$disconnect());
