import { defineConfig } from 'vitest/config';

// .mjs, not .js: the package has no "type": "module", so a .js config would be
// treated as CommonJS and Vitest's own config chain is ESM. The application
// code stays CommonJS and is unaffected.

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.js'],
    globalSetup: ['./test/global-setup.js'],
    setupFiles: ['./test/setup.js'],

    // Every test truncates the whole database, so parallel workers would wipe
    // each other's fixtures mid-run. One fork, one test at a time.
    // (Vitest 4 flattened the old test.poolOptions.forks.* into top-level keys.)
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,

    // The first run pays for CREATE DATABASE plus 19 migrations.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
