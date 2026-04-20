'use strict';

require('dotenv').config();

/**
 * PostgreSQL connection pool configuration.
 * Reads all values from environment variables — never hardcode credentials.
 *
 * SSL is required by Aiven. `rejectUnauthorized: false` is acceptable for
 * development. For production, replace with Aiven's CA certificate:
 *   ssl: { ca: fs.readFileSync('./certs/ca.pem').toString() }
 */
const dbConfig = {
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // Aiven mandates SSL on all connections
  ssl: {
    rejectUnauthorized: false, // set to true + provide CA cert in production
  },

  // Connection pool settings
  max:                parseInt(process.env.DB_POOL_MAX, 10)                || 10,
  idleTimeoutMillis:  parseInt(process.env.DB_POOL_IDLE_TIMEOUT, 10)      || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT, 10) || 2000,
};

// Fail fast: catch missing required variables at startup
const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missing  = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(
    `[DB Config] Missing required environment variables: ${missing.join(', ')}\n` +
    `Ensure your .env file is present and correctly filled in.`
  );
}

module.exports = dbConfig;
