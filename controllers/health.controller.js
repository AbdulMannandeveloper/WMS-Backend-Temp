'use strict';

const { prisma } = require('../lib/prisma');

/**
 * GET /api/health
 * Returns the API status and a live database connectivity check.
 */
const getHealthStatus = async (req, res) => {
  let dbStatus = 'unreachable';
  let dbTime   = null;

  try {
    const result = await prisma.$queryRaw`SELECT NOW() AS db_time`;
    dbStatus = 'connected';
    dbTime   = result[0].db_time;
  } catch (err) {
    console.error('[Health] DB ping failed:', err.message);
  }

  const httpStatus = dbStatus === 'connected' ? 200 : 503;

  res.status(httpStatus).json({
    status:    dbStatus === 'connected' ? 'ok' : 'degraded',
    service:   'ProPackers WMS API',
    timestamp: new Date().toISOString(),
    database: {
      status: dbStatus,
      serverTime: dbTime,
    },
  });
};

module.exports = {
  getHealthStatus,
};
