'use strict';

const prisma = require('../lib/prisma');

/**
 * connectDB
 * Called once at server startup (see server.js).
 * Uses Prisma's pooled connection under the hood.
 */
const connectDB = async () => {
  await prisma.$connect();
  const rows = await prisma.$queryRawUnsafe('SELECT NOW() AS connected_at');

  console.log(
    `[DB] Connected to PostgreSQL successfully — server time: ${rows[0].connected_at}`
  );
};

/**
 * query
 * Compatibility wrapper used by older code paths.
 * Prefer Prisma model operations in new code.
 *
 * @param {string} text   - Parameterised SQL string
 * @param {Array}  params - Bound parameter values
 * @returns {Promise<{rows: any[]}>}
 */
const query = async (text, params = []) => {
  const rows = await prisma.$queryRawUnsafe(text, ...params);
  return { rows };
};

module.exports = {
  connectDB,
  query,
  prisma,
};
