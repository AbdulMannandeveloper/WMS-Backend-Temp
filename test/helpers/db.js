import '../load-env.js';

import prismaLib from '../../lib/prisma.js';

const { prisma } = prismaLib;

let cachedTables = null;

/** Every table in the public schema except Prisma's own migration bookkeeping. */
const getTables = async () => {
  if (cachedTables) return cachedTables;

  const rows = await prisma.$queryRaw`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  cachedTables = rows.map((r) => `"public"."${r.tablename}"`);
  return cachedTables;
};

/**
 * Wipes every table between tests.
 *
 * A single TRUNCATE ... CASCADE rather than ordered deletes, so foreign keys
 * never dictate the order. Per-test transaction rollback is not an option here:
 * the application itself opens interactive transactions (dispatchShipment,
 * createShipmentItem, createInventoryLedger) and Prisma cannot nest them.
 */
export const truncateAll = async () => {
  const tables = await getTables();
  if (tables.length === 0) return;

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`
  );
};

export { getTables, prisma };
