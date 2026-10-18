"use strict";
/**
 * Anti-duplication IP / Port allocation (Region 2, 2nd bullet).
 *
 * Uses a single Prisma transaction with row-level locking
 * (`SELECT ... FOR UPDATE` through $queryRaw) so two concurrent checkouts can
 * never grab the same 10.0.0.x or the same 10xxx SSH port. The row status
 * flips to USED inside the SAME transaction before it commits.
 */
const prisma = require("../lib/prisma");

class ServerFullError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ServerFullError";
  }
}

/**
 * Grab one AVAILABLE IP + one AVAILABLE port, exclusively.
 * @returns {Promise<{ip: string, port: number}>}
 * @throws ServerFullError when either pool is exhausted.
 */
async function allocateIpAndPort(orderId) {
  return prisma.$transaction(
    async (tx) => {
      // Lock one IP row (FOR UPDATE blocks concurrent buyers until commit).
      const ipRows = await tx.$queryRaw`
        SELECT ip FROM available_ip
        WHERE status = 'AVAILABLE'
        ORDER BY ip ASC
        FOR UPDATE LIMIT 1`;
      const ipRow = ipRows[0];
      if (!ipRow) throw new ServerFullError("SERVER_FULL: no AVAILABLE internal IP left");

      const portRows = await tx.$queryRaw`
        SELECT port FROM available_port
        WHERE status = 'AVAILABLE'
        ORDER BY port ASC
        FOR UPDATE LIMIT 1`;
      const portRow = portRows[0];
      if (!portRow) throw new ServerFullError("SERVER_FULL: no AVAILABLE SSH port left");

      const { ip } = ipRow;
      const { port } = portRow;

      await tx.$executeRaw`
        UPDATE available_ip SET status = 'USED', used_by_vm_id = ${orderId} WHERE ip = ${ip}`;
      await tx.$executeRaw`
        UPDATE available_port SET status = 'USED', used_by_vm_id = ${orderId} WHERE port = ${port}`;

      return { ip, port };
    },
    { timeout: 15000, isolationLevel: undefined } // default READ COMMITTED + FOR UPDATE is enough
  );
}

/**
 * Release the slots back to AVAILABLE (used by nuclear rollback + failure path).
 * Idempotent: missing rows are simply ignored.
 */
async function releaseIpAndPort(orderId) {
  await prisma.$executeRaw`
    UPDATE available_ip SET status = 'AVAILABLE', used_by_vm_id = NULL WHERE used_by_vm_id = ${orderId}`.catch(() => {});
  await prisma.$executeRaw`
    UPDATE available_port SET status = 'AVAILABLE', used_by_vm_id = NULL WHERE used_by_vm_id = ${orderId}`.catch(() => {});
}

module.exports = { allocateIpAndPort, releaseIpAndPort, ServerFullError };
