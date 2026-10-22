const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  await p.order.delete({ where: { id: "_sweeptest0001" } }).catch((e) => console.log("order delete:", e.message));
  await p.user.deleteMany({ where: { email: "_expiry-sweep-test@m.y" } });
  console.log("CLEANUP_OK");
})().finally(() => p.$disconnect());
