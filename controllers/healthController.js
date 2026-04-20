'use strict';

const { query } = require('../models/db');

/**
 * GET /api/health
 * Returns the API status and a live database connectivity check.
 */
const getHealthStatus = async (req, res) => {
  let dbStatus = 'unreachable';
  let dbTime   = null;

  try {
    const result = await query('SELECT NOW() AS db_time');
    dbStatus = 'connected';
    dbTime   = result.rows[0].db_time;
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
