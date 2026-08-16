'use strict';

/**
 * Optional Redis client. When REDIS_URL is unset, returns null and callers
 * should fall back to in-memory behaviour (dev / single-instance).
 */

let redisClient = null;
let initAttempted = false;

const getRedisClient = async () => {
  if (initAttempted) return redisClient;
  initAttempted = true;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[Redis] REDIS_URL not set — using in-memory fallbacks');
    return null;
  }

  try {
    const Redis = require('ioredis');
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    redisClient.on('error', (err) => {
      console.error('[Redis] Client error:', err.message);
    });
    await redisClient.ping();
    console.log('[Redis] Connected');
    return redisClient;
  } catch (err) {
    console.error('[Redis] Failed to connect — falling back to memory:', err.message);
    try {
      if (redisClient) await redisClient.quit();
    } catch {
      // ignore
    }
    redisClient = null;
    return null;
  }
};

const disconnectRedis = async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      // ignore
    }
    redisClient = null;
  }
};

module.exports = {
  getRedisClient,
  disconnectRedis,
};
