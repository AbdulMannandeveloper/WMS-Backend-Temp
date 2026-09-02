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

/**
 * Second guard rail: the suite must never send real email.
 *
 * The database guard above exists because the tests truncate every table. This
 * one exists for the same reason in a different direction — the tests enqueue
 * invitations, OTPs and invoice notifications, and a live transport would
 * deliver them, burn the sending quota, and put real addresses in a provider's
 * logs.
 *
 * It is not hypothetical. The real .env reaches this process through
 * prisma.config.ts, which does `import 'dotenv/config'`, so MAIL_TRANSPORT=brevo
 * and a live API key were being picked up by the suite until .env.test set them
 * explicitly. Two mail tests failed and that is the only reason it was noticed.
 */
const transport = String(process.env.MAIL_TRANSPORT || '').toLowerCase();

if (transport === 'smtp' || transport === 'brevo') {
  throw new Error(
    `Refusing to run tests with MAIL_TRANSPORT="${transport}". ` +
      `The suite would send real email. Set MAIL_TRANSPORT= (empty) in .env.test ` +
      `for mock mode.`
  );
}

