'use strict';

/**
 * The user record cached between requests, shared across the cluster.
 *
 * It used to be a per-process Map. ecosystem.config.cjs runs PM2 with
 * instances: 'max', so invalidating on one worker left every other worker
 * serving the stale record for the full TTL — a deactivated account kept
 * working on some requests and not others, and a revoked session survived on
 * whichever workers had not been told.
 *
 * Backed by Redis when REDIS_URL is set, so one invalidation reaches every
 * worker at once. Without it the in-memory Map is still used, which is correct
 * for a single-process development run and is why nothing here fails locally.
 *
 * Reads are best-effort: a Redis hiccup falls through to the database rather
 * than failing the request, because a slower request beats a failed one.
 */

const TTL_MS = Number(process.env.AUTH_USER_CACHE_TTL_MS || 45_000);
const TTL_SECONDS = Math.max(1, Math.round(TTL_MS / 1000));
const KEY_PREFIX = 'authuser:';

/** @type {Map<string, { user: object, expiresAt: number }>} */
const memoryCache = new Map();

let redis = null;
let redisChecked = false;

const getRedis = () => {
  if (redisChecked) return redis;
  redisChecked = true;

  if (!process.env.REDIS_URL) return null;
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on('error', (err) =>
      console.error('[AuthCache] Redis error, falling back to memory:', err.message),
    );
  } catch (err) {
    console.error('[AuthCache] Redis unavailable, using memory:', err.message);
    redis = null;
  }
  return redis;
};

const memoryGet = (userId) => {
  const entry = memoryCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(userId);
    return null;
  }
  return entry.user;
};

const getCachedUser = async (userId) => {
  const client = getRedis();
  if (!client) return memoryGet(userId);

  try {
    const raw = await client.get(KEY_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Never let a cache problem become an auth problem.
    return memoryGet(userId);
  }
};

const setCachedUser = async (userId, user) => {
  const client = getRedis();
  if (!client) {
    memoryCache.set(userId, { user, expiresAt: Date.now() + TTL_MS });
    return;
  }
  try {
    await client.setex(KEY_PREFIX + userId, TTL_SECONDS, JSON.stringify(user));
  } catch {
    memoryCache.set(userId, { user, expiresAt: Date.now() + TTL_MS });
  }
};

/**
 * Drops the entry everywhere. Called by every path that revokes a session or
 * changes a role — the whole revocation mechanism is only as immediate as this.
 */
const invalidateCachedUser = async (userId) => {
  if (!userId) return;
  memoryCache.delete(userId);

  const client = getRedis();
  if (!client) return;
  try {
    await client.del(KEY_PREFIX + userId);
  } catch (err) {
    console.error('[AuthCache] Could not invalidate in Redis:', err.message);
  }
};

const clearAuthUserCache = async () => {
  memoryCache.clear();
  const client = getRedis();
  if (!client) return;
  try {
    const keys = await client.keys(`${KEY_PREFIX}*`);
    if (keys.length) await client.del(...keys);
  } catch {
    // Test-only helper; a failure here is not worth surfacing.
  }
};

const disconnectAuthCache = async () => {
  if (redis) {
    try {
      await redis.quit();
    } catch {
      /* already gone */
    }
    redis = null;
    redisChecked = false;
  }
};

module.exports = {
  getCachedUser,
  setCachedUser,
  invalidateCachedUser,
  clearAuthUserCache,
  disconnectAuthCache,
  TTL_MS,
};
