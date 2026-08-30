#!/usr/bin/env node
'use strict';

/**
 * Catches a controller calling a function its logic module does not export.
 *
 * This is not hypothetical. controllers/client_service.controller.js called
 * clientServiceLogic.getClientServicesByClientId() and .getClientServicesByServiceId(),
 * neither of which existed. Both endpoints failed with "is not a function" for
 * every caller, from the day the routes were written, and nothing noticed —
 * the controller catches and returns 404, so it looked like a missing record.
 *
 * JavaScript resolves a property on a module object at call time, so nothing
 * short of executing the line finds this. check:imports proves a file exists;
 * this proves the function inside it does.
 *
 * Deliberately conservative: it only checks `xxxLogic.method(...)` and
 * `xxxRepository.method(...)` against modules it can require and whose exports
 * it can read. Anything it cannot resolve is skipped rather than guessed at.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['controllers', 'logic'];

// const fooLogic = require('../logic/foo.logic');
const REQUIRE_RE =
  /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;

const problems = [];
let checkedFiles = 0;
let checkedCalls = 0;

for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;

  for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.js'))) {
    const filePath = path.join(abs, file);
    const source = fs.readFileSync(filePath, 'utf8');
    checkedFiles++;

    // Which local name refers to which module.
    const bindings = new Map();
    for (const m of source.matchAll(REQUIRE_RE)) {
      const [, localName, target] = m;
      if (!target.startsWith('.')) continue;
      if (!/(logic|repository|repositry)/i.test(target)) continue;
      bindings.set(localName, target);
    }

    for (const [localName, target] of bindings) {
      let mod;
      try {
        mod = require(path.resolve(path.dirname(filePath), target));
      } catch {
        continue; // Cannot load it — check:imports owns that failure.
      }
      if (!mod || typeof mod !== 'object') continue;

      const calls = source.matchAll(
        new RegExp(`\\b${localName}\\.(\\w+)\\s*\\(`, 'g'),
      );
      for (const call of calls) {
        const method = call[1];
        checkedCalls++;
        if (typeof mod[method] !== 'function') {
          const line = source.slice(0, call.index).split('\n').length;
          problems.push(
            `  ${path.relative(ROOT, filePath)}:${line}  ` +
              `${localName}.${method}() is not exported by ${target}`,
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\n  check:calls — these calls would throw at runtime:\n');
  console.error(problems.join('\n'));
  console.error('');
  process.exit(1);
}

console.log(
  `\n  check:calls — ${checkedCalls} cross-module calls in ${checkedFiles} files, all resolve.\n`,
);
