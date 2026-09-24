/**
 * Server-side paging and filtering on the inventory ledger.
 *
 * Three things were wrong here before, and each has a test below.
 *
 * Narrowing to a client read every product that client owns and put the ids in
 * an IN clause — unbounded, an extra query, and it wrote the same key as the
 * productId filter, so combining the two silently dropped one of them. It is a
 * relation filter now.
 *
 * The end of a date range was built with local setHours, so the boundary moved
 * with the server timezone. This machine runs UTC+5, which is exactly where
 * that shows.
 *
 * And /filter was a second handler taking a subset of the same parameters. It
 * is an alias of the list now, so the two cannot drift while the front end
 * moves across.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import {
  grantPermissions,
  makeAdmin,
  makeEmployee,
  makeClient,
  makeProduct,
  makeLocation,
  makeLedgerEntry,
  seedSeries,
} from '../factories/index.js';
import inventoryLedgerLogic from '../../logic/inventory_ledger.logic.js';

const ids = (body) => body.data.map((row) => row.id);

let admin;
let client;
let product;

beforeEach(async () => {
  admin = await makeAdmin();
  client = (await makeClient()).client;
  product = await makeProduct(client.id, { skuCode: 'SKU-ONE' });
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    await seedSeries(
      3,
      (i, o) => makeLedgerEntry(product.id, admin.id, { timestamp: o.timestamp }),
      { field: 'timestamp', start: new Date('2026-01-01T09:00:00Z') },
    );

    const res = await as(admin).get('/api/inventory-ledgers');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
  });

  it('never returns a password hash with the person who moved the stock', async () => {
    await makeLedgerEntry(product.id, admin.id);

    const res = await as(admin).get('/api/inventory-ledgers');

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});

describe('page boundaries', () => {
  beforeEach(async () => {
    await seedSeries(
      7,
      (i, o) =>
        makeLedgerEntry(product.id, admin.id, {
          timestamp: o.timestamp,
          quantity: 10 + i,
        }),
      { field: 'timestamp', start: new Date('2026-01-01T09:00:00Z') },
    );
  });

  it('walks every row exactly once across pages', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(
        `/api/inventory-ledgers?page=${page}&limit=3`,
      );
      seen.push(...ids(res.body));
    }

    expect(new Set(seen).size).toBe(7);
  });

  it('is newest first by default', async () => {
    const res = await as(admin).get('/api/inventory-ledgers?limit=7');

    expect(res.body.data[0].quantity).toBe(16);
    expect(res.body.data[6].quantity).toBe(10);
  });
});

describe('filters', () => {
  let otherProduct;
  let location;

  beforeEach(async () => {
    otherProduct = await makeProduct(client.id, { skuCode: 'SKU-TWO' });
    location = await makeLocation();

    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      referenceId: 'PO-100',
      notes: 'pallet of blue widgets',
      timestamp: new Date('2026-03-01T10:00:00Z'),
      toLocationId: location.id,
    });
    await makeLedgerEntry(otherProduct.id, admin.id, {
      movementType: 'CHECKOUT',
      referenceId: 'SHP-200',
      timestamp: new Date('2026-03-10T10:00:00Z'),
      fromLocationId: location.id,
    });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'ADJUSTMENT',
      timestamp: new Date('2026-03-20T10:00:00Z'),
    });
  });

  it('narrows by movement type, and by several at once', async () => {
    const one = await as(admin).get(
      '/api/inventory-ledgers?movementType=CHECKOUT',
    );
    expect(one.body.pagination.total).toBe(1);

    const two = await as(admin).get(
      '/api/inventory-ledgers?movementType=CHECKIN,CHECKOUT',
    );
    expect(two.body.pagination.total).toBe(2);
  });

  it('narrows by product, by reference and by location', async () => {
    const byProduct = await as(admin).get(
      `/api/inventory-ledgers?productId=${product.id}`,
    );
    expect(byProduct.body.pagination.total).toBe(2);

    const byReference = await as(admin).get(
      '/api/inventory-ledgers?referenceId=PO-100',
    );
    expect(byReference.body.pagination.total).toBe(1);

    const byFrom = await as(admin).get(
      `/api/inventory-ledgers?fromLocationId=${location.id}`,
    );
    expect(byFrom.body.pagination.total).toBe(1);
  });

  it('searches the sku, the reference and the notes', async () => {
    const bySku = await as(admin).get('/api/inventory-ledgers?search=SKU-TWO');
    expect(bySku.body.pagination.total).toBe(1);

    const byNotes = await as(admin).get(
      '/api/inventory-ledgers?search=blue widgets',
    );
    expect(byNotes.body.pagination.total).toBe(1);
  });

  it('refuses a movement type the enum does not have', async () => {
    const res = await as(admin).get('/api/inventory-ledgers?movementType=TELEPORT');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/movementType must be one of/);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const res = await as(admin).get(
      '/api/inventory-ledgers?movementType=CHECKOUT&limit=2',
    );

    expect(res.body.pagination.total).toBe(1);
  });

  it('combines a product filter with a client filter instead of losing one', async () => {
    // These two used to write the same key, so whichever ran last won and the
    // other silently stopped applying.
    const res = await as(admin).get(
      `/api/inventory-ledgers?productId=${product.id}&clientId=${client.id}`,
    );

    expect(res.body.pagination.total).toBe(2);
    for (const row of res.body.data) expect(row.productId).toBe(product.id);
  });
});

describe('date bounds, in UTC', () => {
  beforeEach(async () => {
    await makeLedgerEntry(product.id, admin.id, {
      timestamp: new Date('2026-04-10T00:00:00Z'),
      quantity: 1,
    });
    await makeLedgerEntry(product.id, admin.id, {
      timestamp: new Date('2026-04-10T23:59:59Z'),
      quantity: 2,
    });
    await makeLedgerEntry(product.id, admin.id, {
      timestamp: new Date('2026-04-11T00:00:00Z'),
      quantity: 3,
    });
  });

  it('includes the whole of the end day, to its last instant', async () => {
    // The row at 23:59:59Z on the end date is the one a local-time boundary
    // drops, or keeps, depending on which side of UTC the server sits.
    const res = await as(admin).get(
      '/api/inventory-ledgers?startDate=2026-04-10&endDate=2026-04-10',
    );

    expect(res.body.pagination.total).toBe(2);
    expect(res.body.data.map((r) => r.quantity).sort()).toEqual([1, 2]);
  });

  it('does not reach into the next day', async () => {
    const res = await as(admin).get(
      '/api/inventory-ledgers?startDate=2026-04-11&endDate=2026-04-11',
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].quantity).toBe(3);
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    await makeLedgerEntry(product.id, admin.id, { quantity: 30 });
    await makeLedgerEntry(product.id, admin.id, { quantity: 10 });
    await makeLedgerEntry(product.id, admin.id, { quantity: 20 });
  });

  it('sorts by quantity', async () => {
    const res = await as(admin).get(
      '/api/inventory-ledgers?sortBy=quantity&sortOrder=asc',
    );

    expect(res.body.data.map((r) => r.quantity)).toEqual([10, 20, 30]);
  });

  it('refuses a column that is not on the list', async () => {
    const res = await as(admin).get('/api/inventory-ledgers?sortBy=notes');

    expect(res.status).toBe(400);
  });
});

describe('the summary', () => {
  beforeEach(async () => {
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      quantity: 10,
    });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      quantity: 5,
    });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKOUT',
      quantity: 3,
    });
  });

  it('totals the whole filtered set, broken down by movement', async () => {
    const res = await as(admin).get('/api/inventory-ledgers/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.totalQuantity).toBe(18);
    expect(res.body.byMovementType.CHECKIN).toEqual({ count: 2, quantity: 15 });
    expect(res.body.byMovementType.CHECKOUT).toEqual({ count: 1, quantity: 3 });
  });

  it('agrees with the list it sits above', async () => {
    const list = await as(admin).get(
      '/api/inventory-ledgers?movementType=CHECKIN&limit=1',
    );
    const summary = await as(admin).get(
      '/api/inventory-ledgers/summary?movementType=CHECKIN',
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
  });

  it('resolves as itself rather than as a field called summary', async () => {
    const res = await as(admin).get('/api/inventory-ledgers/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('byMovementType');
  });
});

describe('/filter, now an alias of the list', () => {
  it('answers exactly what the list answers for the same query', async () => {
    await makeLedgerEntry(product.id, admin.id, { movementType: 'CHECKIN' });
    await makeLedgerEntry(product.id, admin.id, { movementType: 'CHECKOUT' });

    const list = await as(admin).get(
      '/api/inventory-ledgers?movementType=CHECKIN',
    );
    const filter = await as(admin).get(
      '/api/inventory-ledgers/filter?movementType=CHECKIN',
    );

    expect(filter.status).toBe(200);
    expect(ids(filter.body)).toEqual(ids(list.body));
    expect(filter.body.pagination).toEqual(list.body.pagination);
  });
});

describe('client scoping', () => {
  it('narrows to one client through the relation', async () => {
    const other = (await makeClient()).client;
    const otherProduct = await makeProduct(other.id);
    await makeLedgerEntry(product.id, admin.id);
    await makeLedgerEntry(otherProduct.id, admin.id);

    const res = await as(admin).get(
      `/api/inventory-ledgers?clientId=${client.id}`,
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].productId).toBe(product.id);
  });

  it('matches nothing for a client with no products, without a special case', async () => {
    const empty = (await makeClient()).client;
    await makeLedgerEntry(product.id, admin.id);

    const res = await as(admin).get(
      `/api/inventory-ledgers?clientId=${empty.id}`,
    );

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('pages the client-scoped route and keeps its total honest', async () => {
    await seedSeries(
      5,
      (i, o) => makeLedgerEntry(product.id, admin.id, { timestamp: o.timestamp }),
      { field: 'timestamp', start: new Date('2026-05-01T09:00:00Z') },
    );

    const res = await as(admin).get(
      `/api/inventory-ledgers/client/${client.id}?limit=2`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
  });

  it('refuses one client reading another through the scoped route', async () => {
    const { user: clientUser } = await makeClient();
    const res = await as(clientUser).get(
      `/api/inventory-ledgers/client/${client.id}`,
    );

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(product.id);
  });
});

describe('the contracts other code depends on', () => {
  it('getLedgerWithFilters still answers { items } for a hand-built page', async () => {
    // product.logic reads a recent-movements list this way, with its own
    // { skip, take }, and reads .items off the result.
    await seedSeries(
      3,
      (i, o) => makeLedgerEntry(product.id, admin.id, { timestamp: o.timestamp }),
      { field: 'timestamp', start: new Date('2026-06-01T09:00:00Z') },
    );

    const result = await inventoryLedgerLogic.getLedgerWithFilters(
      { productId: product.id },
      { skip: 0, take: 2 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('the product detail still carries its recent movements', async () => {
    for (let i = 0; i < 25; i += 1) {
      await makeLedgerEntry(product.id, admin.id, {
        timestamp: new Date(`2026-06-${String(i + 1).padStart(2, '0')}T09:00:00Z`),
      });
    }

    const res = await as(admin).get(`/api/products/${product.id}/stock`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recentMovements)).toBe(true);
    expect(res.body.recentMovements.length).toBeGreaterThan(0);
  });

  it('the daily checkout summary still sees a whole day', async () => {
    const location = await makeLocation();
    for (let i = 0; i < 60; i += 1) {
      await makeLedgerEntry(product.id, admin.id, {
        movementType: 'CHECKOUT',
        quantity: 1,
        fromLocationId: location.id,
        timestamp: new Date('2026-07-01T10:00:00Z'),
      });
    }

    const res = await as(admin).get(
      '/api/inventory-ledgers/daily-checkout-summary?startDate=2026-07-01&endDate=2026-07-01',
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const totalItems = res.body.reduce(
      (acc, row) => acc + row.items.length,
      0,
    );
    // Sixty checkouts, not a page of fifty.
    expect(totalItems).toBe(60);
  });

  it('the by-field route is still a bare array', async () => {
    await makeLedgerEntry(product.id, admin.id, { referenceId: 'PO-999' });

    const res = await as(admin).get('/api/inventory-ledgers/referenceId/PO-999');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('authorisation', () => {
  it('is open to an employee granted inventory:read', async () => {
    const { user: employee } = await makeEmployee();
    await grantPermissions(employee, 'inventory:read');

    expect((await as(employee).get('/api/inventory-ledgers')).status).toBe(200);
    expect((await as(employee).get('/api/inventory-ledgers/summary')).status).toBe(
      200,
    );
  });
});
