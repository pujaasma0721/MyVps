"use strict";
/**
 * Seed: bootstrap admin, komersial packages, IP/port pool sesuai konstanta tetap.
 */
const bcrypt = require("bcryptjs");
const prisma = require("./../src/lib/prisma");
const { enumeratePool } = require("../src/config/ip-range");
const { SSH_PORT_START, SSH_PORT_END, IP_START, IP_END } = require("../src/config/constants");
const config = require("../src/config");

async function main() {
  console.log(`Seeding pools ${IP_START}..${IP_END} and SSH ports ${SSH_PORT_START}-${SSH_PORT_END}…`);

  // ---- admin user ------------------------------------------------------
  await prisma.user.upsert({
    where: { email: config.admin.email.toLowerCase() },
    update: {
      fullName: config.admin.name,
      passwordHash: await bcrypt.hash(config.admin.password, 10),
      isAdmin: true,
    },
    create: {
      fullName: config.admin.name,
      email: config.admin.email.toLowerCase(),
      passwordHash: await bcrypt.hash(config.admin.password, 10),
      isAdmin: true,
    },
  });

  // ---- komersial packages ----------------------------------------------
  const packages = [
    { name: "K-MICRO",   vcpu: 1, ramMb: 1024, diskGb: 20, priceMonthly: 25000, sortOrder: 1 },
    { name: "K-STARTER", vcpu: 2, ramMb: 2048, diskGb: 40, priceMonthly: 60000, sortOrder: 2 },
    { name: "K-GROW",    vcpu: 4, ramMb: 4096, diskGb: 80, priceMonthly: 120000, sortOrder: 3 },
    { name: "K-BIG",     vcpu: 8, ramMb: 8192, diskGb: 160, priceMonthly: 240000, sortOrder: 4 },
  ];
  // Dedupe: packages are keyed by NAME as primary-id-like lookup, so wipe
  // strays created by earlier runs (create lacked explicit id -> cuid duplicates).
  for (const p of packages) {
    await prisma.package.upsert({
      where: { id: p.name },
      update: { priceMonthly: p.priceMonthly, sortOrder: p.sortOrder },
      create: { ...p, id: p.name }, // explicit id keeps re-seeds idempotent
    });
  }

  // ---- IP pool ----------------------------------------------------------
  const ipData = enumeratePool().map((ip) => ({ ip }));
  await prisma.availableIp.createMany({ data: ipData, skipDuplicates: true });
  console.log(`  → AvailableIp seeded: ${ipData.length} rows (${IP_START}..${IP_END})`);

  // ---- SSH port pool ----------------------------------------------------
  const ports = [];
  for (let p = SSH_PORT_START; p <= SSH_PORT_END; p++) ports.push({ port: p });
  await prisma.availablePort.createMany({ data: ports, skipDuplicates: true });
  console.log(`  → AvailablePort seeded: ${ports.length} rows (${SSH_PORT_START}-${SSH_PORT_END})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
