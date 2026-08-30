/**
 * Runs once per `vitest` invocation, before any worker starts.
 *
 *   1. Loads .env.test (and refuses a non-test database).
 *   2. Creates the test database if it does not exist.
 *   3. Applies all migrations with `prisma migrate deploy`.
 *
 * Works against either a native Postgres or the one in docker-compose.test.yml —
 * it only cares about DATABASE_URL.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseName } from './load-env.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Same server, but connected to the `postgres` maintenance database. */
const maintenanceUrl = () => {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
};

const ensureDatabaseExists = async () => {
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl() });

  try {
    const rows = await admin.$queryRaw`
      SELECT 1 FROM pg_database WHERE datname = ${databaseName}
    `;

    if (rows.length === 0) {
      // Identifier cannot be parameterised; databaseName is validated by
      // load-env.js and comes from our own .env.test, not from user input.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
      console.log(`[test] Created database "${databaseName}"`);
    }
  } catch (err) {
    throw new Error(
      `Could not reach Postgres at ${maintenanceUrl().replace(/:[^:@]*@/, ':***@')}\n` +
        `  ${err.message.split('\n')[0]}\n\n` +
        `  Start a database first:\n` +
        `    native Postgres — make sure the service is running\n` +
        `    Docker          — npm run test:db:up`
    );
  } finally {
    await admin.$disconnect();
  }
};

const applyMigrations = () => {
  execSync('npx prisma migrate deploy', {
    cwd: projectRoot,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
};

/** Where UPLOAD_DIR resolves to, so teardown removes the right thing. */
const uploadDir = () =>
  process.env.UPLOAD_DIR
    ? path.resolve(projectRoot, process.env.UPLOAD_DIR)
    : null;

export default async function setup() {
  await ensureDatabaseExists();

  try {
    applyMigrations();
  } catch (err) {
    const detail = [err.stdout?.toString(), err.stderr?.toString()]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(`prisma migrate deploy failed:\n${detail || err.message}`);
  }

  console.log(`[test] Database "${databaseName}" ready`);

  // Vitest runs a returned function after the last test file. Without it the
  // suite leaves its written files behind in a working directory — the invoice
  // PDF tests alone had accumulated over a hundred.
  return () => {
    const dir = uploadDir();
    if (!dir) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[test] Could not clean ${dir}: ${err.message}`);
    }
  };
}
