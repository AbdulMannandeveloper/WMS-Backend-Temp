'use strict';

/**
 * PM2 cluster config — uses all CPU cores for the Express API.
 * Start: npm run start:cluster  (or: pm2 start ecosystem.config.cjs)
 */
module.exports = {
  apps: [
    {
      name: 'propackers-api',
      script: 'server.js',
      instances: process.env.WEB_CONCURRENCY || 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
      kill_timeout: 15000,
      listen_timeout: 10000,
      wait_ready: false,
    },
  ],
};
