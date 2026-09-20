/**
 * Server-side paging and filtering on the rate card.
 *
 * This list is admin-only and stays that way. A client reads its own rates
 * through /client/:clientId, where ownership of the path parameter is checked —
 * so the clientId filter here is a convenience for staff, not a scoping
 * mechanism. The last block pins that distinction, because the day this route
 * is opened to the client role, that parameter has to move behind
 * resolveClientFilter first.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeService,
  makeClientService,
} from '../factories/index.js';

const ids = (body) => body.data.map((row) => row.id);

let admin;

beforeEach(async () => {
  admin = await makeAdmin();
});

describe('the envelope', () => {
  it('answers { data, pagination } with the defaults applied', async () => {
    const { client } = await makeClient();
    for (let i = 0; i < 3; i += 1) {
      const service = await makeService({ description: `Service ${i}` });
      await makeClientService(client.id, service.id);
    }

    const res = await as(admin).get('/api/client-services');

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

  it('carries the client and service names, which it never used to', async () => {
    // getAllClientServices had no include at all, so the rate card could only
    // show ids. Searching or sorting by a name needs them joined.
    const { client } = await makeClient({ companyName: 'Northwind Freight' });
    const service = await makeService({ description: 'Pallet handling' });
    await makeClientService(client.id, service.id);

    const res = await as(admin).get('/api/client-services');

    expect(res.body.data[0].client.companyName).toBe('Northwind Freight');
    expect(res.body.data[0].service.description).toBe('Pallet handling');
  });
});

describe('page boundaries', () => {
  beforeEach(async () => {
    const { client } = await makeClient({ companyName: 'Acme' });
    for (let i = 0; i < 7; i += 1) {
      const service = await makeService({
        description: `S-${String(i).padStart(2, '0')}`,
      });
      await makeClientService(client.id, service.id, {
        chargedPrice: `${10 + i}.00`,
      });
    }
  });

  it('walks every row exactly once across pages', async () => {
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await as(admin).get(
        `/api/client-services?page=${page}&limit=3`,
      );
      seen.push(...ids(res.body));
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('is ordered by client then service, which is how a rate card reads', async () => {
    const res = await as(admin).get('/api/client-services?limit=10');

    const descriptions = res.body.data.map((r) => r.service.description);
    expect(descriptions).toEqual([...descriptions].sort());
  });
});

describe('filters', () => {
  let acme;
  let northwind;
  let packing;

  beforeEach(async () => {
    acme = (await makeClient({ companyName: 'Acme Logistics' })).client;
    northwind = (await makeClient({ companyName: 'Northwind Freight' })).client;

    packing = await makeService({ description: 'Packing', unit: 'item' });
    const palletising = await makeService({
      description: 'Palletising',
      unit: 'pallet',
    });

    await makeClientService(acme.id, packing.id, {
      chargedPrice: '1.50',
      unit: 'item',
    });
    await makeClientService(acme.id, palletising.id, {
      chargedPrice: '12.00',
      unit: 'pallet',
    });
    await makeClientService(northwind.id, packing.id, {
      chargedPrice: '2.00',
      unit: 'item',
    });
  });

  it('narrows by client', async () => {
    const res = await as(admin).get(`/api/client-services?clientId=${acme.id}`);

    expect(res.body.pagination.total).toBe(2);
  });

  it('narrows by service', async () => {
    const res = await as(admin).get(
      `/api/client-services?serviceId=${packing.id}`,
    );

    expect(res.body.pagination.total).toBe(2);
  });

  it('searches the company name and the service description', async () => {
    const byCompany = await as(admin).get('/api/client-services?search=Northwind');
    expect(byCompany.body.pagination.total).toBe(1);

    const byService = await as(admin).get('/api/client-services?search=Palletising');
    expect(byService.body.pagination.total).toBe(1);
  });

  it('narrows by a price range, comparing numerically', async () => {
    const res = await as(admin).get(
      '/api/client-services?priceMin=1.75&priceMax=5',
    );

    expect(res.body.pagination.total).toBe(1);
    expect(Number(res.body.data[0].chargedPrice)).toBe(2);
  });

  it('narrows by unit', async () => {
    const res = await as(admin).get('/api/client-services?unit=pallet');

    expect(res.body.pagination.total).toBe(1);
  });

  it('counts what the filter matched, not what the table holds', async () => {
    const res = await as(admin).get(
      `/api/client-services?clientId=${acme.id}&limit=1`,
    );

    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.totalPages).toBe(2);
  });

  it('combines filters rather than letting one overwrite another', async () => {
    const res = await as(admin).get(
      `/api/client-services?clientId=${acme.id}&unit=item`,
    );

    expect(res.body.pagination.total).toBe(1);
    expect(Number(res.body.data[0].chargedPrice)).toBe(1.5);
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    const { client } = await makeClient({ companyName: 'Acme' });
    for (const [desc, price] of [
      ['Beta', '30.00'],
      ['Alpha', '10.00'],
      ['Gamma', '20.00'],
    ]) {
      const service = await makeService({ description: desc });
      await makeClientService(client.id, service.id, { chargedPrice: price });
    }
  });

  it('sorts by charged price', async () => {
    const res = await as(admin).get(
      '/api/client-services?sortBy=chargedPrice&sortOrder=asc',
    );

    expect(res.body.data.map((r) => Number(r.chargedPrice))).toEqual([
      10, 20, 30,
    ]);
  });

  it('sorts by service description', async () => {
    const res = await as(admin).get(
      '/api/client-services?sortBy=serviceDescription&sortOrder=desc',
    );

    expect(res.body.data.map((r) => r.service.description)).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ]);
  });

  it('refuses a column that is not on the list', async () => {
    const res = await as(admin).get('/api/client-services?sortBy=clientId');

    expect(res.status).toBe(400);
  });
});

describe('malformed parameters', () => {
  it('answer 400, and never leak the query builder', async () => {
    const cases = [
      '/api/client-services?clientId=not-a-uuid',
      '/api/client-services?serviceId=not-a-uuid',
      '/api/client-services?priceMin=abc',
      '/api/client-services?priceMin=99&priceMax=1',
    ];

    for (const url of cases) {
      const res = await as(admin).get(url);
      expect(res.status, url).toBe(400);
      expect(JSON.stringify(res.body), url).not.toMatch(/prisma|P20\d\d/i);
    }
  });
});

describe('the summary', () => {
  beforeEach(async () => {
    const acme = (await makeClient({ companyName: 'Acme' })).client;
    const northwind = (await makeClient({ companyName: 'Northwind' })).client;
    const packing = await makeService({ description: 'Packing' });
    const palletising = await makeService({ description: 'Palletising' });

    await makeClientService(acme.id, packing.id);
    await makeClientService(acme.id, palletising.id);
    await makeClientService(northwind.id, packing.id);
  });

  it('counts the whole filtered set, across clients and services', async () => {
    const res = await as(admin).get('/api/client-services/summary?limit=1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 3, clientCount: 2, serviceCount: 2 });
  });

  it('agrees with the list it sits above', async () => {
    const list = await as(admin).get('/api/client-services?search=Packing&limit=1');
    const summary = await as(admin).get(
      '/api/client-services/summary?search=Packing',
    );

    expect(summary.body.total).toBe(list.body.pagination.total);
  });

  it('ignores paging and sorting entirely', async () => {
    const plain = await as(admin).get('/api/client-services/summary');
    const noisy = await as(admin).get(
      '/api/client-services/summary?page=2&limit=1&sortBy=chargedPrice',
    );

    expect(noisy.body).toEqual(plain.body);
  });

  it('resolves as itself rather than as a rate with that id', async () => {
    const res = await as(admin).get('/api/client-services/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clientCount');
  });
});

describe('who may read the rate card', () => {
  it('is admin only — the list is not a client-facing route', async () => {
    const { user: employee } = await makeEmployee();
    const { user: clientUser } = await makeClient();

    expect((await as(employee).get('/api/client-services')).status).toBe(403);
    expect((await as(clientUser).get('/api/client-services')).status).toBe(403);
    expect((await as(clientUser).get('/api/client-services/summary')).status).toBe(
      403,
    );
  });

  it('a client still reads its own rates through the scoped route', async () => {
    const { user: clientUser, client } = await makeClient();
    const service = await makeService({ description: 'Packing' });
    await makeClientService(client.id, service.id);

    const own = await as(clientUser).get(`/api/client-services/client/${client.id}`);
    expect(own.status).toBe(200);
    expect(Array.isArray(own.body)).toBe(true);
    expect(own.body).toHaveLength(1);
  });

  it('and cannot reach another client through that route', async () => {
    const { user: clientUser } = await makeClient();
    const { client: other } = await makeClient();
    const service = await makeService({ description: 'Packing' });
    await makeClientService(other.id, service.id);

    const res = await as(clientUser).get(`/api/client-services/client/${other.id}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(other.id);
  });
});
