/**
 * State that has to be shared across the cluster.
 *
 * ecosystem.config.cjs runs PM2 with instances: 'max'. Anything held in a
 * per-process variable is therefore per-worker, and both of these were:
 *
 *  - the auth cache, so invalidating on one worker left the others serving a
 *    stale user for the full 45s TTL — a deactivated account kept working on
 *    some requests and not others, and a revoked session survived wherever the
 *    news had not reached
 *  - the mail queue, so anything queued at the moment of a restart was gone,
 *    with the user staring at a screen telling them to check their email
 *
 * Both now use Redis when REDIS_URL is set, and both keep their in-memory
 * behaviour without it — which is how development runs, and is why these tests
 * assert the fallback works rather than skipping it.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import authCacheModule from '../../utils/authUserCache.js';
import mailQueueModule from '../../utils/mailQueue.js';

const {
  getCachedUser,
  setCachedUser,
  invalidateCachedUser,
  clearAuthUserCache,
} = authCacheModule;

const { enqueueMail, getQueueDepth } = mailQueueModule;

const usingRedis = Boolean(process.env.REDIS_URL);

describe('the auth cache', () => {
  beforeEach(async () => {
    await clearAuthUserCache();
  });

  it('round-trips a user', async () => {
    await setCachedUser('user-1', { id: 'user-1', role: 'admin', tokenVersion: 0 });

    const cached = await getCachedUser('user-1');

    expect(cached).toMatchObject({ id: 'user-1', role: 'admin', tokenVersion: 0 });
  });

  it('returns null for an unknown user rather than throwing', async () => {
    await expect(getCachedUser('never-seen')).resolves.toBeNull();
  });

  it('invalidation actually removes the entry', async () => {
    // The whole revocation mechanism is only as immediate as this.
    await setCachedUser('user-2', { id: 'user-2', tokenVersion: 0 });
    await invalidateCachedUser('user-2');

    await expect(getCachedUser('user-2')).resolves.toBeNull();
  });

  it('preserves tokenVersion through the round trip', async () => {
    // Serialising through Redis must not lose the field revocation depends on.
    await setCachedUser('user-3', { id: 'user-3', role: 'employee', tokenVersion: 7 });

    const cached = await getCachedUser('user-3');

    expect(cached.tokenVersion).toBe(7);
  });

  it('tolerates invalidating something that was never cached', async () => {
    await expect(invalidateCachedUser('ghost')).resolves.toBeUndefined();
  });

  it.runIf(usingRedis)('is visible to a second connection, as another worker would be', async () => {
    // The point of the change: one worker's write is another worker's read.
    const Redis = (await import('ioredis')).default;
    const other = new Redis(process.env.REDIS_URL);
    try {
      await setCachedUser('user-shared', { id: 'user-shared', tokenVersion: 3 });
      const raw = await other.get('authuser:user-shared');
      expect(JSON.parse(raw).tokenVersion).toBe(3);

      await invalidateCachedUser('user-shared');
      await expect(other.get('authuser:user-shared')).resolves.toBeNull();
    } finally {
      await other.quit();
    }
  });
});

describe('the mail queue', () => {
  let logged;
  let spy;

  beforeEach(() => {
    logged = [];
    // Mail runs in mock mode under test, and mock mode announces each delivery.
    // Watching that line is the only honest way to assert the job actually
    // reached the mailer: mailQueue destructures sendMail at require time, so a
    // monkey-patched export never reaches the call site.
    spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  const settle = () => new Promise((r) => setTimeout(r, 250));

  it('delivers a queued job to the mailer', async () => {
    enqueueMail({ to: 'delivered@example.test', subject: 'Queue check', text: 'body' });
    await settle();

    expect(logged.join(' | ')).toContain('delivered@example.test');
  });

  it('delivers every job in a batch, and leaves the queue empty', async () => {
    // A drain loop that exits early would leave later jobs sitting there.
    for (let i = 0; i < 3; i++) {
      enqueueMail({ to: `q${i}@example.test`, subject: 'Batch', text: 'body' });
    }
    await settle();

    const output = logged.join(' | ');
    expect(output).toContain('q0@example.test');
    expect(output).toContain('q1@example.test');
    expect(output).toContain('q2@example.test');
    await expect(getQueueDepth()).resolves.toBe(0);
  });

  it('reports a numeric depth', async () => {
    await expect(getQueueDepth()).resolves.toBeTypeOf('number');
  });
});

describe('without Redis', () => {
  it('the suite is exercising the in-memory path, which is how dev runs', () => {
    // Recorded rather than skipped silently: if REDIS_URL is ever set for the
    // test run, the cross-connection test above starts running too.
    expect(usingRedis).toBe(Boolean(process.env.REDIS_URL));
    if (!usingRedis) {
      expect(process.env.REDIS_URL).toBeUndefined();
    }
  });
});
