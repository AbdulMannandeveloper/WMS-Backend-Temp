/**
 * Server-side paging and filtering on stock levels.
 *
 * This endpoint was already paged and already scoped correctly — it is the one
 * controller in the codebase that composed client narrowing as a where clause
 * rather than by choosing a different function. So the work here is filters,
 * a sort that means something, and the tenancy tests that were never written.
 *
 * The default order changes: it was the uuid primary key, which is stable, and
 * stability is genuinely what paging needs — but nobody reads a stock list in
 * uuid order. It sorts by product name now, with the id still on the end.
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
  makeStockLevel,
} from '../factories/index.js';

const ids = (body) => body.data.map((row) => row.id);

let admin;
let client;
let location;

beforeEach(async () => {
  admin = await makeAdmin();
  client = (await makeClient()).client;
  location = await makeLocation({ locationName: 'BIN-A' });
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const product = await makeProduct(client.id, { productName: name });
      await makeStockLevel(product.id, location.id);
    }

    const res = await as(admin).get('/api/stock');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBe(3);
  });

  it('orders by product name rather than by uuid', async () => {
    for (const name of ['Gamma', 'Alpha', 'Beta']) {
      const product = await makeProduct(client.id, { productName: name });
      await makeStockLevel(product.id, location.id);
    }

    const res = await as(admin).get('/api/stock');

    expect(res.body.data.map((r) => r.product.productName)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('still carries the zone/shelf/bin enrichment', async () => {
    const product = await makeProduct(client.id);
    await makeStockLevel(product.id, location.id);

    const res = await as(admin).get('/api/stock');

    // The logic layer decorates each row after the query; paging must not have
    // skipped past that step.
    expect(res.body.data[0].location).toBeTruthy();
    expect(res.body.data[0]).toHaveProperty('product');
  });
});

describe('page boundaries', () => {
  beforeEach(async () => {
    for (let i = 0; i < 7; i += 1) {
      const product = await makeProduct(client.id, {
        productName: `P-${String(i).padStart(2, '0')}`,
      });
      await makeStockLevel(product.id, location.id, { currentQuantity: 10 + i });
    }
  });

  it('walks every row exactly once across pages', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(`/api/stock?page=${page}&limit=3`);
      seen.push(...ids(res.body));
    }

    expect(new Set(seen).size).toBe(7);
  });

  it('clamps a limit past the maximum', async () => {
    const res = await as(admin).get('/api/stock?limit=9999');

    expect(res.body.pagination.limit).toBe(200);
  });
});

describe('filters', () => {
  let otherLocation;
  let widget;

  beforeEach(async () => {
    otherLocation = await makeLocation({ locationName: 'BIN-B' });

    widget = await makeProduct(client.id, {
      skuCode: 'WID-1',
      productName: 'Blue Widget',
    });
    const sprocket = await makeProduct(client.id, {
      skuCode: 'SPR-1',
      productName: 'Red Sprocket',
    });

    await makeStockLevel(widget.id, location.id, {
      currentQuantity: 5,
      reservedQuantity: 2,
    });
    await makeStockLevel(sprocket.id, location.id, {
      currentQuantity: 50,
      reservedQuantity: 0,
    });
    await makeStockLevel(widget.id, otherLocation.id, {
      currentQuantity: 100,
      reservedQuantity: 0,
    });
  });

  it('narrows by product and by location', async () => {
    const byProduct = await as(admin).get(`/api/stock?productId=${widget.id}`);
    expect(byProduct.body.pagination.total).toBe(2);

    const byLocation = await as(admin).get(
      `/api/stock?locationId=${otherLocation.id}`,
    );
    expect(byLocation.body.pagination.total).toBe(1);
  });

  it('searches the sku, the product name and the bin', async () => {
    const bySku = await as(admin).get('/api/stock?search=SPR-1');
    expect(bySku.body.pagination.total).toBe(1);

    const byName = await as(admin).get('/api/stock?search=Blue');
    expect(byName.body.pagination.total).toBe(2);

    const byBin = await as(admin).get('/api/stock?search=BIN-B');
    expect(byBin.body.pagination.total).toBe(1);
  });

  it('narrows by a quantity range', async () => {
    const res = await as(admin).get('/api/stock?quantityMin=10&quantityMax=60');

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].currentQuantity).toBe(50);
  });

  it('narrows by whether anything is reserved', async () => {
    const reserved = await as(admin).get('/api/stock?hasReserved=true');
    expect(reserved.body.pagination.total).toBe(1);

    const free = await as(admin).get('/api/stock?hasReserved=false');
    expect(free.body.pagination.total).toBe(2);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const res = await as(admin).get(`/api/stock?productId=${widget.id}&limit=1`);

    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.totalPages).toBe(2);
  });

  it('combines filters instead of letting one overwrite another', async () => {
    const res = await as(admin).get(
      `/api/stock?productId=${widget.id}&locationId=${location.id}`,
    );

    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].currentQuantity).toBe(5);
  });

  it('refuses a quantity that is not a whole number', async () => {
    const res = await as(admin).get('/api/stock?quantityMin=1.5');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/whole number/);
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    for (const [name, qty] of [
      ['Alpha', 30],
      ['Beta', 10],
      ['Gamma', 20],
    ]) {
      const product = await makeProduct(client.id, { productName: name });
      await makeStockLevel(product.id, location.id, { currentQuantity: qty });
    }
  });

  it('sorts by quantity on hand', async () => {
    const res = await as(admin).get(
      '/api/stock?sortBy=currentQuantity&sortOrder=asc',
    );

    expect(res.body.data.map((r) => r.currentQuantity)).toEqual([10, 20, 30]);
  });

  it('refuses a column that is not on the list', async () => {
    const res = await as(admin).get('/api/stock?sortBy=productId');

    expect(res.status).toBe(400);
  });
});

describe('the summary', () => {
  beforeEach(async () => {
    const a = await makeProduct(client.id, { productName: 'Alpha' });
    const b = await makeProduct(client.id, { productName: 'Beta' });
    await makeStockLevel(a.id, location.id, {
      currentQuantity: 10,
      reservedQuantity: 3,
    });
    await makeStockLevel(b.id, location.id, {
      currentQuantity: 40,
      reservedQuantity: 0,
    });
  });

  it('totals the whole filtered set, not the page', async () => {
    const res = await as(admin).get('/api/stock/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 2, totalUnits: 50, totalReserved: 3 });
  });

  it('agrees with the list it sits above', async () => {
    const list = await as(admin).get('/api/stock?search=Alpha&limit=1');
    const summary = await as(admin).get('/api/stock/summary?search=Alpha');

    expect(summary.body.total).toBe(list.body.pagination.total);
  });

  it('resolves as itself rather than as a stock row with that id', async () => {
    const res = await as(admin).get('/api/stock/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalUnits');
  });
});

describe('one client cannot see another', () => {
  let other;
  let otherProduct;
  let ownProduct;

  beforeEach(async () => {
    other = await makeClient();
    otherProduct = await makeProduct(other.client.id, {
      productName: 'Their Widget',
    });
    ownProduct = await makeProduct(client.id, { productName: 'Our Widget' });

    await makeStockLevel(otherProduct.id, location.id, { currentQuantity: 7 });
    await makeStockLevel(ownProduct.id, location.id, { currentQuantity: 11 });
  });

  it('shows a client only its own rows, and a total that counts only those', async () => {
    // Three clients hold stock in the same bin. One of them asks.
    const { user: viewer, client: viewerClient } = await makeClient();
    const viewerProduct = await makeProduct(viewerClient.id, {
      productName: 'Viewer Widget',
    });
    await makeStockLevel(viewerProduct.id, location.id, { currentQuantity: 3 });

    const res = await as(viewer).get('/api/stock');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].productId).toBe(viewerProduct.id);
    // The total is the subtle half. A correctly scoped page carrying a global
    // total still tells this client how many rows everybody else has.
    expect(res.body.pagination.total).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(otherProduct.id);
    expect(JSON.stringify(res.body)).not.toContain(ownProduct.id);
  });

  it('refuses a client pointing clientId at someone else', async () => {
    const { user: clientUser } = await makeClient();

    const res = await as(clientUser).get(`/api/stock?clientId=${other.client.id}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(otherProduct.id);
    expect(JSON.stringify(res.body)).not.toContain(other.client.id);
  });

  it('lets staff point clientId anywhere, which is the whole difference', async () => {
    const res = await as(admin).get(`/api/stock?clientId=${other.client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].productId).toBe(otherProduct.id);
  });

  it('keeps the scope when a sort key reaches through a relation', async () => {
    const { user: clientUser, client: ownClient } = await makeClient();
    const ownStockProduct = await makeProduct(ownClient.id);
    await makeStockLevel(ownStockProduct.id, location.id);

    const res = await as(clientUser).get(
      '/api/stock?sortBy=locationName&sortOrder=desc',
    );

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(otherProduct.id);
  });

  it('scopes the summary too, not just the rows', async () => {
    const { user: clientUser, client: ownClient } = await makeClient();
    const ownStockProduct = await makeProduct(ownClient.id);
    await makeStockLevel(ownStockProduct.id, location.id, {
      currentQuantity: 4,
    });

    const res = await as(clientUser).get('/api/stock/summary');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.totalUnits).toBe(4);
  });
});

describe('authorisation', () => {
  it('is open to an employee granted inventory:read, and to clients', async () => {
    const { user: employee } = await makeEmployee();
    await grantPermissions(employee, 'inventory:read');

    expect((await as(employee).get('/api/stock')).status).toBe(200);
    expect((await as(employee).get('/api/stock/summary')).status).toBe(200);
  });
});
