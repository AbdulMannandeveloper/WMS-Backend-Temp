#!/usr/bin/env node
'use strict';

/**
 * Runs the suite with Redis attached.
 *
 * The Redis-backed auth cache and mail queue have an in-memory fallback, and
 * without REDIS_URL that fallback is the only path anything ever executes —
 * test/platform/shared-state.js reports its cross-worker test as *skipped*,
 * not passed. This is the command that actually exercises the real path.
 *
 *   npm run test:db:up      brings up Postgres AND redis-test on 6380
 *   npm run test:redis      runs the suite against them
 *
 * A node script rather than an inline `REDIS_URL=... vitest` because npm runs
 * scripts through cmd.exe on Windows, where that prefix syntax is not a thing.
 */

const { spawnSync } = require('node:child_process');
const net = require('node:net');

const URL = process.env.REDIS_URL || 'redis://localhost:6380';

const parse = (url) => {
  try {
    const u = new global.URL(url);
    return { host: u.hostname, port: Number(u.port || 6379) };
  } catch {
    return null;
  }
};

const reachable = ({ host, port }) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

(async () => {
  const target = parse(URL);
  if (!target) {
    console.error(`\n  test:redis — REDIS_URL is not a valid url: ${URL}\n`);
    process.exit(1);
  }

  if (!(await reachable(target))) {
    // Refuse rather than fall back. Falling back is exactly the failure this
    // command exists to prevent: a green run that proved nothing.
    console.error(
      `\n  test:redis — nothing listening on ${target.host}:${target.port}.\n` +
        `  Start it first:  npm run test:db:up\n`,
    );
    process.exit(1);
  }

  console.log(`\n  test:redis — using ${URL}\n`);
  const result = spawnSync('npx', ['vitest', 'run'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, REDIS_URL: URL },
  });
  process.exit(result.status ?? 1);
})();
