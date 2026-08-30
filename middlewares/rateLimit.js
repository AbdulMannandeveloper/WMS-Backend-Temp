'use strict';

/**
 * Rate limiters, shared so every one of them gets the same store.
 *
 * With REDIS_URL set the counters live in Redis, which matters under PM2
 * clustering: a per-process counter means the real limit is (limit x workers),
 * and which worker you land on decides whether you are throttled.
 *
 * Two things this file exists to get right:
 *
 *  - `express-rate-limit` keys on `req.ip`. Behind nginx that is nginx's address
 *    for every request unless `trust proxy` is set, which collapses every user
 *    into one bucket — ten failed logins from anybody would lock out everybody.
 *    app.js sets it; there is a test asserting the two stay in step.
 *
 *  - Limits are off under NODE_ENV=test, because 115 tests hammering the API
 *    trip any sane limit and fail in ways that look like real bugs. A test
 *    asserts they are enabled outside test, so turning them off for
 *    convenience cannot quietly become turning them off everywhere.
 */

const rateLimit = require('express-rate-limit');

const isDisabled = () => process.env.NODE_ENV === 'test';

let sharedStoreClient = null;

/** One Redis connection for every limiter, created on first use. */
const getStoreClient = () => {
  if (!process.env.REDIS_URL) return null;
  if (sharedStoreClient) return sharedStoreClient;

  try {
    const Redis = require('ioredis');
    sharedStoreClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
    });
    sharedStoreClient.on('error', (err) =>
      console.error('[RateLimit] Redis error:', err.message),
    );
    return sharedStoreClient;
  } catch (err) {
    console.error('[RateLimit] Redis unavailable, counters stay per-process:', err.message);
    return null;
  }
};

/**
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max
 * @param {string} opts.prefix   Redis key prefix, so limiters do not share counters
 * @param {string} [opts.message]
 */
const buildLimiter = ({ windowMs, max, prefix, message }) => {
  if (isDisabled()) {
    // A pass-through, so routes read the same in every environment.
    return (req, res, next) => next();
  }

  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Too many requests. Please try again shortly.' },
  };

  const client = getStoreClient();
  if (client) {
    try {
      const { RedisStore } = require('rate-limit-redis');
      options.store = new RedisStore({
        sendCommand: (...args) => client.call(...args),
        prefix,
      });
      console.log(`[RateLimit] ${prefix} using Redis store`);
    } catch (err) {
      console.error(`[RateLimit] ${prefix} falling back to memory:`, err.message);
    }
  }

  return rateLimit(options);
};

/**
 * Credential endpoints. Deliberately strict — this is the one guarding against
 * someone working through a password list.
 */
const authLimiter = () =>
  buildLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    prefix: 'rl:auth:',
    message: 'Too many attempts. Please try again later.',
  });

/**
 * Everything else. Generous on purpose: a picker working through a pallet with
 * a scanner produces a genuine burst, and throttling the warehouse to protect
 * the warehouse is not a trade worth making.
 */
const globalLimiter = () =>
  buildLimiter({
    windowMs: 60 * 1000,
    max: 300,
    prefix: 'rl:global:',
  });

module.exports = { buildLimiter, authLimiter, globalLimiter, isDisabled };
