# Test suite

Integration tests: real HTTP requests through real routes against a real
Postgres. Nothing is mocked — the bugs this suite exists to catch all live in
the seam between the logic layer and the database, which is exactly what a mock
would hide.

## Running

```bash
npm test          # one pass
npm run test:watch
```

The first run creates the database and applies all migrations automatically.

## The database

`DATABASE_URL` in `.env.test` decides where tests run. Copy `.env.test.example`
to `.env.test` if you don't have one.

**Native Postgres** (default) — a separate database on your existing server, so
dev data is untouched:

```
DATABASE_URL="postgres://postgres@localhost:5432/propackers_test"
```

**Docker** — for machines without a local Postgres, and for CI:

```bash
npm run test:db:up      # Postgres on 5433
npm run test:db:down    # stop, delete volume
```
then point `.env.test` at `postgres://propackers:propackers@localhost:5433/propackers_test`.

> The suite **truncates every table** between tests. `test/load-env.js` refuses
> to start unless the database name contains `test`, which is what stops a
> mistyped URL from wiping your development data.

## Layout

| Path | |
|---|---|
| `load-env.js` | Loads `.env.test`, enforces the test-database guard |
| `global-setup.js` | Creates the database, runs `prisma migrate deploy` — once per run |
| `setup.js` | Truncates tables and clears the auth cache before every test |
| `helpers/db.js` | `truncateAll()`, and the shared `prisma` client |
| `helpers/auth.js` | `as(user)` — a supertest agent carrying that user's token |
| `factories/` | Fixture builders, including `makeWarehouseScenario()` |
| `smoke.test.js` | Proves the rig works |
| `billing/` | Invoice totals |
| `shipments/` | Creation, lifecycle, services, dispatch |

## Writing a test

```js
import { describe, it, expect } from 'vitest';
import { as } from './helpers/auth.js';
import { makeAdmin, makeWarehouseScenario } from './factories/index.js';

it('does the thing', async () => {
  const admin = await makeAdmin();
  const { product } = await makeWarehouseScenario();

  const res = await as(admin).get(`/api/products/${product.id}`);

  expect(res.status).toBe(200);
});
```

`as(user)` mints a token with the same `signAuthToken` the real login uses, so
tests never have to drive the password + OTP flow.

Tests run **sequentially in a single worker**. They share one database and
truncate between each, so parallel workers would wipe each other's fixtures.

## Phase 1 regression suites

Three defects found in the original codebase review were written as tests
**before** their fixes, using Vitest's `it.fails` — which passes only while the
body throws. CI stayed green while the bugs were open, and each test started
failing the moment its bug was fixed, forcing whoever fixed it to drop `.fails`
and keep the test. The red-to-green handoff enforced itself.

All three have now graduated out of `known-bugs/`, and the directory is gone:

| Suite | Bug it guards against | Fixed in |
|---|---|---|
| `billing/invoice-total.test.js` | Totals string-concatenated: a £100 invoice plus £50 became £10,050 | 1.1 |
| `shipments/status.test.js` | State machine was browser-only; an employee could force `DISPATCHED`, or set `BANANA` | 1.2 |
| `shipments/dispatch.test.js` | Dispatch always 400d — `prisma.shipmentServiceMapping` had no model or table | 1.3 |

`shipments/create.test.js` and `shipments/services.test.js` cover two further
bugs found while fixing those: a circular import that broke shipment creation
outright, and a non-transactional create that stranded reserved stock against
shipments the caller was told had failed.

**Do not make a failing regression test pass by loosening its assertions.** They
describe behaviour that was paid for once already.

## Money

**Never do money arithmetic in JavaScript on a value that came out of Prisma.**

Prisma maps `Decimal` columns to a Decimal object whose `valueOf()` returns a
string, so `+` concatenates instead of adding:

```js
Decimal('100.00') + 50   // "10050", not 150.00
```

That single operator turned a £100 invoice into £10,050. `<` comparisons against
the result then silently pass, because they are comparing strings.

Two safe options:

- **Aggregate in the database.** `prisma.x.aggregate({ _sum: ... })` returns a
  Decimal computed by Postgres. This is how `recalculateInvoiceTotal` works, and
  it is the preferred approach for anything summing rows.
- **Use Decimal's own methods** — `.plus()`, `.minus()`, `.times()` — when you
  genuinely must compute in JS, as `scripts/repair-invoice-totals.js` does.

`Number(x) + Number(y)` is acceptable for small fixed calculations but
reintroduces float error over many rows; prefer the database.
