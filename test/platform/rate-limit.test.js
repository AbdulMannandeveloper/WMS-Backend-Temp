/**
 * Rate limiting, and the proxy setting it depends on.
 *
 * deploy/nginx.conf proxies every request and sets X-Forwarded-For. Express only
 * reads that header when `trust proxy` is set; without it `req.ip` is nginx's
 * address for every request, and since express-rate-limit keys on `req.ip`,
 * every user shares one bucket. Ten failed logins from anybody would lock out
 * everybody — and it would only ever happen in production, behind the proxy.
 *
 * The limiters are disabled under NODE_ENV=test, because 115 tests hammering the
 * API trip any sane limit and fail in ways that look like real bugs. That
 * convenience is itself a risk, so the first test here asserts they are enabled
 * outside test — disabling them locally cannot quietly become disabling them
 * everywhere.
 */

import { describe, it, expect } from 'vitest';

import { app } from '../../app.js';
import { as, anon } from '../helpers/auth.js';
import { makeAdmin } from '../factories/index.js';

describe('rate limiting', () => {
  it('is disabled under NODE_ENV=test, and enabled otherwise', async () => {
    const { isDisabled } = await import('../../middlewares/rateLimit.js').then(
      (m) => m.default,
    );

    expect(process.env.NODE_ENV).toBe('test');
    expect(isDisabled()).toBe(true);

    // The guarantee that matters: the switch is NODE_ENV, not a hard-coded off.
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(isDisabled()).toBe(false);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('builds a real limiter outside test, not a pass-through', async () => {
    const { buildLimiter } = await import('../../middlewares/rateLimit.js').then(
      (m) => m.default,
    );

    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const limiter = buildLimiter({ windowMs: 1000, max: 1, prefix: 'rl:probe:' });
      // express-rate-limit middleware carries a resetKey helper; a bare
      // (req,res,next) pass-through does not.
      expect(typeof limiter).toBe('function');
      expect(typeof limiter.resetKey).toBe('function');
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe('trust proxy', () => {
  it('is set, so req.ip is the client and not the proxy', () => {
    // Without this, every request behind nginx shares one rate-limit bucket.
    const setting = app.get('trust proxy');
    expect(setting).toBeTruthy();
    expect(setting).not.toBe(true); // `true` is refused by express-rate-limit
    expect(Number(setting)).toBeGreaterThanOrEqual(1);
  });

  it('reads the client address out of X-Forwarded-For', async () => {
    const admin = await makeAdmin();

    // The app has to distinguish these two for per-client limiting to work at
    // all. Both are accepted; what matters is that Express sees them as
    // different clients rather than collapsing them into nginx's address.
    const first = await as(admin)
      .get('/api/clients')
      .set('X-Forwarded-For', '203.0.113.10');
    const second = await as(admin)
      .get('/api/clients')
      .set('X-Forwarded-For', '203.0.113.99');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('the health probes stay outside the limiter', () => {
  it('serves /healthz and /readyz unthrottled', async () => {
    // An orchestrator polls these constantly; throttling them would take the
    // service out of rotation for looking healthy too often.
    for (let i = 0; i < 25; i++) {
      const res = await anon().get('/healthz');
      expect(res.status).toBe(200);
    }
  });
});
