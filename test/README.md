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
| `known-bugs/` | See below |

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

## `known-bugs/`

Three defects found during the codebase review, written as tests **before** the
fixes. They use Vitest's `it.fails`, which passes only while the body throws.

That means CI stays green today, and the moment the underlying bug is fixed the
test **starts failing** — which is the signal to delete `.fails` and keep it as
a permanent regression test. The red-to-green handoff enforces itself.

| File | Bug | Fixed by |
|---|---|---|
| `invoice-total.test.js` | Invoice totals string-concatenate: £100 + £50 = £10,050 | Chunk 1.1 |
| `dispatch.test.js` | Dispatch always 400s — `prisma.shipmentServiceMapping` does not exist | Chunk 1.3 |
| `shipment-status.test.js` | Status machine is browser-only; an employee can force `DISPATCHED`, or set `BANANA` | Chunk 1.2 |

**Do not "fix" a failing `known-bugs` test by loosening its assertions.** The
assertions describe the behaviour the fix must produce.
