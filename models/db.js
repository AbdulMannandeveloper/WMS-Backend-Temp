'use strict';

const { Pool } = require('pg');
const dbConfig  = require('../config/db.config');

/**
 * Singleton connection pool.
 * Re-use this pool across the entire application — never create a new Pool
 * per request, as that will exhaust your database connections.
 */
const pool = new Pool(dbConfig);

// Propagate unexpected pool-level errors to the console instead of crashing.
pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected idle client error:', err.message);
});

/**
 * connectDB
 * Called once at server startup (see server.js).
 * Acquires a test client to verify the connection is alive before
 * the HTTP server starts accepting requests.
 */
const connectDB = async () => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW() AS connected_at');
    console.log(
      `[DB] Connected to PostgreSQL successfully — server time: ${result.rows[0].connected_at}`
    );
  } finally {
    client.release(); // always release back to the pool
  }
};

/**
 * query
 * Thin wrapper around pool.query.
 * Use this in all controllers instead of importing `pool` directly —
 * it keeps query logic centralised and easy to instrument later.
 *
 * @param {string} text   - Parameterised SQL string
 * @param {Array}  params - Bound parameter values
 * @returns {Promise<pg.Result>}
 */
const query = (text, params) => pool.query(text, params);

module.exports = {
  connectDB,
  query,
  pool, // exported for advanced use-cases (transactions, etc.)
};
