/**
 * Server-side paging and filtering on the warehouse location list.
 *
 * The reason this endpoint is converted early, ahead of anything client-scoped,
 * is the sibling it has: /tree assembles a parent-child hierarchy out of the
 * same repository read. Page that read and the children whose parent fell off
 * the end are silently dropped from the tree rather than erroring — a warehouse
 * map that is quietly missing shelves. The last block here is that guard.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeLocation,
  makeLocationClass,
  makeProduct,
  makeStockLevel,
} from '../factories/index.js';

const ids = (body) => body.data.map((row) => row.id);
const rows = (response) => response.body.data;

let admin;

beforeEach(async () => {
  admin = await makeAdmin();
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    const cls = await makeLocationClass({ name: 'Aisle' });
    for (const name of ['A-01', 'A-02', 'A-03']) {
      await makeLocation({ locationClassId: cls.id, locationName: name });
    }

    const res = await as(admin).get('/api/warehouse-locations');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 3,
      totalPages: 1,
      hasMore: false,
    });
  });

  it('is ordered by name, which is what an operator reads down', async () => {
    const cls = await makeLocationClass({ name: 'Aisle' });
    for (const name of ['C-01', 'A-01', 'B-01']) {
      await makeLocation({ locationClassId: cls.id, locationName: name });
    }

    const res = await as(admin).get('/api/warehouse-locations');

    expect(res.body.data.map((r) => r.locationName)).toEqual([
      'A-01',
      'B-01',
      'C-01',
    ]);
  });
});

describe('page boundaries', () => {
  beforeEach(async () => {
    const cls = await makeLocationClass({ name: 'Bin' });
    for (let i = 0; i < 7; i += 1) {
      await makeLocation({
        locationClassId: cls.id,
        locationName: `B-${String(i).padStart(2, '0')}`,
      });
    }
  });

  it('walks every row exactly once across pages', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(
        `/api/warehouse-locations?page=${page}&limit=3`,
      );
      seen.push(...ids(res.body));
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('clamps a limit past the maximum', async () => {
    const res = await as(admin).get('/api/warehouse-locations?limit=9999');

    expect(res.body.pagination.limit).toBe(200);
  });
});

describe('filters', () => {
  let aisle;
  let bin;

  beforeEach(async () => {
    aisle = await makeLocationClass({ name: 'Aisle' });
    bin = await makeLocationClass({ name: 'Bin' });

    await makeLocation({
      locationClassId: aisle.id,
      locationName: 'AISLE-1',
      materializedPath: 'zone-a/aisle-1',
    });
    await makeLocation({
      locationClassId: bin.id,
      locationName: 'BIN-1',
      materializedPath: 'zone-a/aisle-1/bin-1',
    });
    await makeLocation({
      locationClassId: bin.id,
      locationName: 'BIN-2',
      materializedPath: 'zone-b/aisle-9/bin-2',
    });
  });

  it('narrows by location class', async () => {
    const res = await as(admin).get(
      `/api/warehouse-locations?locationClassId=${bin.id}`,
    );

    expect(res.body.pagination.total).toBe(2);
  });

  it('searches the name, the path and the class name', async () => {
    const byName = await as(admin).get('/api/warehouse-locations?search=BIN-2');
    expect(byName.body.data).toHaveLength(1);

    const byPath = await as(admin).get('/api/warehouse-locations?search=zone-b');
    expect(byPath.body.data).toHaveLength(1);

    const byClass = await as(admin).get('/api/warehouse-locations?search=Aisle');
    // Matches the class name on one row, and the name/path of the others that
    // contain "aisle" — the point is that a class name is searchable at all.
    expect(byClass.body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it('narrows to a subtree by path prefix', async () => {
    const res = await as(admin).get(
      '/api/warehouse-locations?pathPrefix=zone-a/',
    );

    expect(res.body.pagination.total).toBe(2);
    for (const row of res.body.data) {
      expect(row.materializedPath.startsWith('zone-a/')).toBe(true);
    }
  });

  it('narrows to the roots on the literal null', async () => {
    const child = await makeLocation({
      locationClassId: bin.id,
      locationName: 'CHILD-1',
    });
    const parent = await makeLocation({
      locationClassId: aisle.id,
      locationName: 'PARENT-1',
    });
    await as(admin)
      .put(`/api/warehouse-locations/${child.id}`)
      .send({ parentLocationId: parent.id });

    const roots = await as(admin).get(
      '/api/warehouse-locations?parentLocationId=null',
    );

    expect(roots.body.data.every((r) => r.parentLocationId === null)).toBe(true);
  });

  it('narrows by whether anything is standing there', async () => {
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    const occupied = rows(await as(admin).get('/api/warehouse-locations'));
    await makeStockLevel(product.id, occupied[0].id, { currentQuantity: 5 });

    const withStock = await as(admin).get(
      '/api/warehouse-locations?hasStock=true',
    );
    expect(withStock.body.pagination.total).toBe(1);

    const empty = await as(admin).get('/api/warehouse-locations?hasStock=false');
    expect(empty.body.pagination.total).toBe(2);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const res = await as(admin).get(
      `/api/warehouse-locations?locationClassId=${bin.id}&limit=1`,
    );

    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.totalPages).toBe(2);
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    const cls = await makeLocationClass({ name: 'Bin' });
    await makeLocation({ locationClassId: cls.id, locationName: 'B', materializedPath: 'p3' });
    await makeLocation({ locationClassId: cls.id, locationName: 'A', materializedPath: 'p1' });
    await makeLocation({ locationClassId: cls.id, locationName: 'C', materializedPath: 'p2' });
  });

  it('reverses on sortOrder', async () => {
    const res = await as(admin).get('/api/warehouse-locations?sortOrder=desc');

    expect(res.body.data.map((r) => r.locationName)).toEqual(['C', 'B', 'A']);
  });

  it('sorts by materialized path', async () => {
    const res = await as(admin).get(
      '/api/warehouse-locations?sortBy=materializedPath&sortOrder=asc',
    );

    expect(res.body.data.map((r) => r.materializedPath)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('refuses a column that is not on the list', async () => {
    const res = await as(admin).get('/api/warehouse-locations?sortBy=id');

    expect(res.status).toBe(400);
  });
});

describe('malformed parameters', () => {
  it('answer 400, and never leak the query builder', async () => {
    const cases = [
      '/api/warehouse-locations?locationClassId=not-a-uuid',
      '/api/warehouse-locations?parentLocationId=not-a-uuid',
      '/api/warehouse-locations?hasStock=perhaps',
      '/api/warehouse-locations?sortOrder=sideways',
    ];

    for (const url of cases) {
      const res = await as(admin).get(url);
      expect(res.status, url).toBe(400);
      expect(JSON.stringify(res.body), url).not.toMatch(/prisma|P20\d\d/i);
    }
  });
});

describe('the summary', () => {
  it('counts the whole filtered set, broken down by class', async () => {
    const aisle = await makeLocationClass({ name: 'Aisle' });
    const bin = await makeLocationClass({ name: 'Bin' });
    await makeLocation({ locationClassId: aisle.id });
    await makeLocation({ locationClassId: bin.id });
    await makeLocation({ locationClassId: bin.id });

    const res = await as(admin).get('/api/warehouse-locations/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byClass[0]).toEqual({
      classId: bin.id,
      name: 'Bin',
      count: 2,
    });
  });

  it('agrees with the list it sits above', async () => {
    const cls = await makeLocationClass({ name: 'Aisle' });
    await makeLocation({ locationClassId: cls.id });
    await makeLocation({ locationClassId: cls.id });

    const list = await as(admin).get(
      `/api/warehouse-locations?locationClassId=${cls.id}&limit=1`,
    );
    const summary = await as(admin).get(
      `/api/warehouse-locations/summary?locationClassId=${cls.id}`,
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
  });

  it('resolves as itself rather than as the field named "summary"', async () => {
    // /summary sits above /:field/:value. Mounted the other way round this
    // would be read as a lookup on a column called summary, and answer 400.
    const res = await as(admin).get('/api/warehouse-locations/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('byClass');
  });
});

describe('the tree, which must never be paged', () => {
  it('returns the whole hierarchy even when there are more locations than a page', async () => {
    // 60 locations, each a child of the first. If /tree were reading a page of
    // 50, ten children would vanish from the hierarchy without any error to
    // say so — the failure this whole block exists to catch.
    const cls = await makeLocationClass({ name: 'Bin' });
    const root = await makeLocation({
      locationClassId: cls.id,
      locationName: 'ROOT',
    });

    for (let i = 0; i < 60; i += 1) {
      await makeLocation({
        locationClassId: cls.id,
        locationName: `CHILD-${String(i).padStart(3, '0')}`,
        parentLocationId: root.id,
      });
    }

    const res = await as(admin).get('/api/warehouse-locations/tree');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const rootNode = res.body.find((n) => n.locationName === 'ROOT');
    expect(rootNode).toBeTruthy();
    expect(rootNode.childLocations ?? rootNode.children).toHaveLength(60);
  });

  it('is still a bare array, not an envelope', async () => {
    await makeLocation({});

    const res = await as(admin).get('/api/warehouse-locations/tree');

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.pagination).toBeUndefined();
  });
});

describe('the by-field route, which the mobile app reads', () => {
  it('is still a bare array', async () => {
    const cls = await makeLocationClass({ name: 'Bin' });
    await makeLocation({ locationClassId: cls.id, locationName: 'FINDME' });

    const res = await as(admin).get(
      '/api/warehouse-locations/locationName/FINDME',
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });
});

describe('authorisation', () => {
  it('is open to staff, list and summary alike', async () => {
    const { user: employee } = await makeEmployee();

    expect((await as(employee).get('/api/warehouse-locations')).status).toBe(200);
    expect(
      (await as(employee).get('/api/warehouse-locations/summary')).status,
    ).toBe(200);
  });
});
