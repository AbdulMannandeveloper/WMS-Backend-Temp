'use strict';

const TTL_MS = Number(process.env.AUTH_USER_CACHE_TTL_MS || 45_000);

/** @type {Map<string, { user: object, expiresAt: number }>} */
const cache = new Map();

const getCachedUser = (userId) => {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(userId);
    return null;
  }
  return entry.user;
};

const setCachedUser = (userId, user) => {
  cache.set(userId, { user, expiresAt: Date.now() + TTL_MS });
};

const invalidateCachedUser = (userId) => {
  if (userId) cache.delete(userId);
};

const clearAuthUserCache = () => {
  cache.clear();
};

module.exports = {
  getCachedUser,
  setCachedUser,
  invalidateCachedUser,
  clearAuthUserCache,
  TTL_MS,
};
