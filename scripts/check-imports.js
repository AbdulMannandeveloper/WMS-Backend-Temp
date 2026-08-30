#!/usr/bin/env node
'use strict';

/**
 * Fails if a tracked file requires something that is not itself tracked.
 *
 * Written after exactly that happened: controllers/monthly_invoice.controller.js
 * was committed carrying `require('../utils/clientScope')`, while
 * utils/clientScope.js was still untracked. At HEAD the app died at module load
 * with MODULE_NOT_FOUND and every test file failed — but the working tree had
 * the file, so every local run stayed green and nothing surfaced it.
 *
 *   npm run check:imports
 *
 * Only relative requires are checked; package imports are npm's problem, and a
 * missing one fails loudly at install time anyway.
 *
 * Exits non-zero on a finding, so it drops into CI unchanged. The stronger
 * version of this check is CI running the suite on a clean checkout.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RELATIVE_REQUIRE = /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g;
// Static and dynamic ESM, for the test tree.
const RELATIVE_IMPORT = /\bfrom\s+['"](\.[^'"]+)['"]|\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;

const CANDIDATE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs'];

const tracked = new Set(
  execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    // git reports forward slashes; normalise for comparison on Windows.
    .map((f) => f.replace(/\\/g, '/')),
);

const sourceFiles = [...tracked].filter((f) => /\.(js|mjs|cjs)$/.test(f));

const findings = [];

for (const file of sourceFiles) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const dir = path.dirname(file);
  const specifiers = new Set();

  for (const re of [RELATIVE_REQUIRE, RELATIVE_IMPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1] || m[2];
      if (spec) specifiers.add(spec);
    }
  }

  for (const spec of specifiers) {
    const base = path.posix.join(dir.replace(/\\/g, '/'), spec);
    const resolved = CANDIDATE_SUFFIXES.some((suffix) => tracked.has(base + suffix));

    if (!resolved) {
      // Distinguish "exists locally but uncommitted" — the dangerous case, since
      // it works for you and for nobody else — from a plain broken path.
      const existsOnDisk = CANDIDATE_SUFFIXES.some((suffix) => {
        try {
          return fs.existsSync(base + suffix);
        } catch {
          return false;
        }
      });

      findings.push({
        file,
        spec,
        reason: existsOnDisk
          ? 'exists on disk but is NOT tracked — it would be missing for anyone else'
          : 'does not resolve to any tracked file',
      });
    }
  }
}

if (findings.length === 0) {
  console.log(
    `\n  check:imports — ${sourceFiles.length} tracked source files, every relative import resolves.\n`,
  );
  process.exit(0);
}

console.error(`\n  check:imports — ${findings.length} unresolved import(s):\n`);
for (const f of findings) {
  console.error(`    ${f.file}`);
  console.error(`      requires '${f.spec}'`);
  console.error(`      ${f.reason}\n`);
}
console.error(
  '  A tracked file importing an untracked one means the committed tree does not\n' +
    '  run, however green it looks locally. Commit the missing file, or drop the\n' +
    '  import from what you are committing.\n',
);
process.exit(1);
