# ProPackers WMS — Backend conventions (read this first)

Express, **CommonJS** (`require`/`module.exports`, `'use strict'`, single quotes), Prisma 6.19 / Postgres, Vitest **ESM** tests + supertest. Read this instead of re-reading large source files; open a specific file only when you need an exact signature.

## Layering
`routes → controllers → logic → repositories → prisma`. Templates to copy: **Returns** (`logic/product_return.logic.js`, its controller/routes/repository) and **Air Freight** (`logic/air_freight_*`, `repositories/air_freight_*`).

## Repositories
- `const db = (tx) => tx || prisma;` — `tx` is the **last** arg on every fn.
- Module-level `includeRelations` / `*Summary` select constants; `userSummary` selects id+name only.
- Conditional status move = `transitionIfStatus(id, fromStatuses[], data, tx)` → `updateMany({where:{id,status:{in}}}) ` returns `count` (0 = someone raced you). Pattern origin: `repositories/product_return.repository.js:resolveIfOpen`.
- Reference series: `getLatestReferencesInSeries(prefix, take, tx)`.

## Logic
- `withStatus(msg, status)` for 404/409/403; plain `Error` = 400.
- `audit(actor, ACTION, details)` wrapper that **never throws** (`.catch(console.error)`), always **after commit**.
- Reference generator: copy `nextReturnReference` + `isReferenceClash` (P2002 on `reference`) + retry loop (5 attempts). Prefixes: SHP/BULK/RET/AF/HO.
- Row lock a parent before re-checking: `` tx.$queryRaw`SELECT id FROM <table> WHERE id=${id}::uuid FOR UPDATE` `` (see `fba.logic.js:lockShipment`, `air_freight_flight.logic.js:lockFlight`).
- `TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 }` (manifest commit uses 120_000).
- List endpoints: define `<X>_LIST_SPEC = { filters:[...], sort:{allowed,defaultSort,tiebreaker} }` and use `buildListQuery(query, SPEC)` from `utils/queryFilters.js`. Tenant scope via `withScope(where, scopeClientId ? {clientId} : undefined)`.

## Controllers
- `pick(body, [allowlist])` per write (mass-assignment guard); actor = `req.user.id` (never from body).
- `fail(res, err)`: status from `err.status`, else `/not found/i`→404, else 400. `HAS_DEPENDENTS`→409 `dependentsBody(err)`.
- Lists: `buildListQuery` + `paginatedResponse(items,total,pagination)` + `listError(res,err,ctx)`.

## Client scoping (portal)
`utils/clientScope.js`: `resolveOwnClientId(user)` (null for staff), `resolveClientFilter`. **Every staff-only route needs `authorizeRoles('admin','employee')` FIRST** — `requirePermission`/`holdsPermission` let clients AND admins through. Cross-tenant access → **404** (never 403). Redact client responses (air freight: `utils/airFreightRedact.js`).

## Dependents / delete
`utils/dependents.js`: `buildReport({blocking,removedWith})`, `assertDeletable(subject, report, {deactivatable})`, `lockForDelete(tx,table,id)`, `HasDependentsError`, `dependentsBody`. A new blocking FK must be added to the parent's `get*Dependents`.

## Billing
Charges land on existing MonthlyInvoice: `resolveOpenInvoiceFor(clientId, tx)` + `recalculateInvoiceTotal(invoiceId, tx)` (**recomputes tax — never inline-sum**). Per-client rates via `getRateForClient(clientId, code, tx)` (returns Decimal `unitPrice` — `Number()` it before any pure calc). Services seeded lazily (`ensure*Services`). Reversal: `removeChargeLines`, `paidAmong` from `logic/reversal.js`; PAID invoice lines block reversal.

## Migrations — CRITICAL
- Hand-written SQL + prose header, applied with **`prisma migrate deploy`**. **NEVER `prisma migrate dev`** — it drops partial indexes as drift.
- Generate table SQL: `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (diffs live DB vs schema; apply earlier migrations with deploy first).
- Partial unique indexes are raw SQL, **no Prisma `@unique`** (e.g. `uq_air_freight_boxes_tracking_active`, `uq_products_barcode_ci`). Mirror the predicate in code as a status constant.
- Enum value add must be its **own** migration (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`), Postgres can't use it in the same tx.

## Permissions
`utils/permissions.js` MODULES (hardcoded `module:action`) mirrored in frontend `src/lib/permissions.ts`. 5 modules × 4 = 20 tokens. `holdsPermission` passes admin + client; only employee is governed.

## Uploads / storage
`lib/objectStorage.js`: `uploadBuffer(key,buf,type)`, `getObjectStream(key)`, `removeStoredFile`. Register each prefix KIND in `logic/upload_sweep.logic.js` (sweeps orphans >24h). Air freight prefixes: `afmanifest-`/`afphoto-`/`afproof-`/`aflabel-`. Multer memory; `middlewares/upload.js` (photos, 5MB, ext+MIME) and `middlewares/manifestUpload.js` (csv/xlsx, 10MB, ext only) wrapped by `handleUploadErrors` → 400.

## Tests (`test/`, real Postgres)
- `test/helpers/auth.js`: `as(user)`, `anon()`. Factories in `test/factories/index.js` (`makeAdmin/makeEmployee/makeClient` → `{user,client}`, `grantPermissions(user,[...])`, `makeCourier/makeAirFreightFlight/makeAirFreightBox`, `ALL_TEST_PERMISSIONS`). Grant perms **before** the first request.
- During dev run only the relevant folder: `npx vitest run test/air-freight` (~1 min). **Run the FULL suite alone (~20 min) only once at the end** — suites share one DB and truncate it; never run two concurrently.
- Checks: `npm run check:imports`, `npm run check:calls` (git-add new files first so they resolve).

## Shell
Git Bash on Windows. Heredocs with backticks/apostrophes break — write to scratchpad then `cat >>`. `cd` to the other repo persists across Bash calls.
