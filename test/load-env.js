/**
 * Loads .env.test and refuses to continue unless it points at a test database.
 *
 * Required before anything touches lib/prisma.js, because PrismaClient reads
 * DATABASE_URL at construction time.
 *
 * The regular .env is never loaded here. It carries live SMTP credentials and
 * the development DATABASE_URL, and the suite truncates every table it can see.
 *
 * ESM (despite the .js extension and the package being CommonJS) because Vitest
 * runs the test tree through Vite's transform. The application code is untouched.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const envPath = path.join(here, '..', '.env.test');

// override: true so a stale DATABASE_URL already in the shell cannot win.
dotenv.config({ path: envPath, override: true, quiet: true });

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    `DATABASE_URL is not set. Copy .env.test.example to .env.test (expected at ${envPath}).`
  );
}

// Guard rail. Every test truncates every table in this database, so pointing it
// at a development or production database would destroy real data.
export const databaseName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

if (!/test/i.test(databaseName)) {
  throw new Error(
    `Refusing to run tests against database "${databaseName}". ` +
      `The test suite truncates every table, so DATABASE_URL in .env.test must ` +
      `name a dedicated database with "test" in it (e.g. propackers_test).`
  );
}
