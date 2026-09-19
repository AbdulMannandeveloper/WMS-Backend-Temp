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
 *
 * A second pass covers the other half of the same mistake — see BARE CALLS
 * below.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['controllers', 'logic'];

// The second pass reaches further, because the shared helpers in utils/ are
// destructured into repositories too.
const BARE_CALL_DIRS = ['controllers', 'logic', 'repositories', 'middlewares'];

// Matches a binding like:  const fooLogic = <require of ../logic/foo.logic>
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

/**
 * BARE CALLS — a shared helper used without being destructured in.
 *
 * The pass above catches `someLogic.missing()`. It cannot catch
 * `assertAllowedField(field, FIELDS)` in a file that never required it: there
 * is no module object to inspect, just a free identifier that is undefined at
 * runtime. That is a ReferenceError, and a controller's try/catch turns it into
 * a 400 — so the endpoint reads as "bad request" rather than "broken", which is
 * how it stays broken.
 *
 * Exactly that happened to shipment_service_mapping.repository.js: two
 * assertAllowedField calls, no require, and attaching a service to a shipment
 * started answering 400. `node --check` parses it happily, because nothing is
 * syntactically wrong.
 *
 * Scoped to names utils/ exports, so this stays a fact about the codebase
 * rather than a guess about which identifiers ought to exist.
 */
const utilsDir = path.join(ROOT, 'utils');
const utilExports = new Map(); // exported name -> the module that provides it

if (fs.existsSync(utilsDir)) {
  for (const file of fs.readdirSync(utilsDir).filter((f) => f.endsWith('.js'))) {
    let mod;
    try {
      mod = require(path.join(utilsDir, file));
    } catch {
      continue;
    }
    if (!mod || typeof mod !== 'object') continue;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function' && !utilExports.has(name)) {
        utilExports.set(name, `utils/${file}`);
      }
    }
  }
}

let checkedBareCalls = 0;

for (const dir of BARE_CALL_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;

  for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.js'))) {
    const filePath = path.join(abs, file);
    const source = fs.readFileSync(filePath, 'utf8');

    // Strip comments first: the fix for this very bug added a comment naming
    // assertAllowedField, and a prose mention is not a call.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const [name, provider] of utilExports) {
      const called = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm').test(code);
      if (!called) continue;

      checkedBareCalls++;

      const destructured = new RegExp(
        `\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*require\\(`,
      ).test(code);
      const declaredHere = new RegExp(
        `(?:const|let|var|function)\\s+${name}\\b`,
      ).test(code);

      if (!destructured && !declaredHere) {
        const idx = code.search(new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm'));
        const line = code.slice(0, Math.max(idx, 0)).split('\n').length;
        problems.push(
          `  ${path.relative(ROOT, filePath)}:${line}  ` +
            `${name}() is called but never required from ${provider}`,
        );
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
  `\n  check:calls — ${checkedCalls} cross-module calls in ${checkedFiles} files, ` +
    `plus ${checkedBareCalls} uses of ${utilExports.size} shared helpers, all resolve.\n`,
);
