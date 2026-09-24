/**
 * Shipments and FBA under permission control.
 *
 * Both modules carry state transitions rather than plain CRUD, so two mappings
 * are judgement calls and are asserted here rather than left to be inferred:
 * cancelling is a delete, and reopening is an update.
 *
 * Two things stay admin-only whatever is granted — attaching a billable service
 * to a shipment, and writing the FBA category list. Both are commercial or
 * reference decisions rather than warehouse work, and the last block pins that
 * so a later "make everything grantable" does not quietly take them with it.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeProduct,
  makeLocation,
  makeStockLevel,
  makeShipment,
  grantPermissions,
} from '../factories/index.js';
import { prisma } from '../helpers/db.js';

let admin;
let employeeUser;
let client;
let shipment;
let category;

const grant = (...permissions) => grantPermissions(employeeUser, ...permissions);

beforeEach(async () => {
  admin = await makeAdmin();
  const made = await makeEmployee();
  employeeUser = made.user;
  client = (await makeClient()).client;
  shipment = await makeShipment(made.employee.id, client.id);

  category = await prisma.fbaCategory.create({
    data: { name: `Cat-${Math.random().toString(36).slice(2, 8)}` },
  });
});

const fbaConsignment = async () =>
  await prisma.fbaShipment.create({
    data: {
      // reference is required now (the bulk-shipment number); these permission
      // tests only care about the 403/allowed status, not the flow, so a unique
      // placeholder is enough.
      reference: `BULK-TEST-${Math.random().toString(36).slice(2, 10)}`,
      categoryId: category.id,
      clientId: client.id,
    },
  });

describe('an employee holding nothing', () => {
  it('is refused shipments and FBA alike', async () => {
    const calls = [
      as(employeeUser).get('/api/shipments'),
      as(employeeUser).post('/api/shipments').send({}),
      as(employeeUser).post(`/api/shipments/${shipment.id}/ready`),
      as(employeeUser).delete(`/api/shipments/${shipment.id}`),
      as(employeeUser).get('/api/fba-shipments'),
      as(employeeUser).post('/api/fba-shipments').send({}),
    ];

    for (const call of calls) {
      await expect(call.then((r) => r.status)).resolves.toBe(403);
    }
  });
});

describe('shipments:read', () => {
  it('opens the lists and the service view, and nothing else', async () => {
    await grant('shipments:read');

    expect((await as(employeeUser).get('/api/shipments')).status).toBe(200);
    expect(
      (await as(employeeUser).get(`/api/shipments/${shipment.id}/services`)).status,
    ).toBe(200);

    expect((await as(employeeUser).post('/api/shipments').send({})).status).toBe(403);
  });
});

describe('shipments:create', () => {
  it('opens raising a shipment', async () => {
    const product = await makeProduct(client.id);
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 10 });
    await grant('shipments:create');

    const res = await as(employeeUser)
      .post('/api/shipments')
      .send({
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 2 },
        ],
      });

    expect(res.status).toBe(201);
  });
});

describe('shipments:update', () => {
  it('opens the warehouse sequence — ready, dispatch, tracking, picking', async () => {
    await grant('shipments:update', 'shipments:read');

    // Each is guarded by the state machine underneath; what matters here is
    // that the permission let the request reach it at all.
    for (const call of [
      as(employeeUser).post(`/api/shipments/${shipment.id}/ready`),
      as(employeeUser).post(`/api/shipments/${shipment.id}/dispatch`),
      as(employeeUser)
        .put(`/api/shipments/${shipment.id}/tracking`)
        .send({ trackingId: 'TRK-1' }),
    ]) {
      await expect(call.then((r) => r.status)).resolves.not.toBe(403);
    }
  });

  it('covers reopening, which walks the shipment backwards rather than removing it', async () => {
    await grant('shipments:update');

    const res = await as(employeeUser).post(`/api/shipments/${shipment.id}/reopen`);

    expect(res.status).not.toBe(403);
  });

  it('does not open cancelling or deleting', async () => {
    await grant('shipments:update');

    expect(
      (await as(employeeUser).post(`/api/shipments/${shipment.id}/cancel`)).status,
    ).toBe(403);
    expect(
      (await as(employeeUser).delete(`/api/shipments/${shipment.id}`)).status,
    ).toBe(403);
  });
});

describe('shipments:delete', () => {
  it('opens cancelling, which is the soft delete of a shipment', async () => {
    await grant('shipments:delete');

    const res = await as(employeeUser).post(`/api/shipments/${shipment.id}/cancel`);

    expect(res.status).not.toBe(403);
  });

  it('opens removing one outright', async () => {
    await grant('shipments:delete');

    const res = await as(employeeUser).delete(`/api/shipments/${shipment.id}`);

    expect(res.status).not.toBe(403);
  });

  it('does not open the warehouse sequence', async () => {
    await grant('shipments:delete');

    expect(
      (await as(employeeUser).post(`/api/shipments/${shipment.id}/ready`)).status,
    ).toBe(403);
  });
});

describe('fba', () => {
  it('read opens the list and the categories the arrival form needs', async () => {
    await grant('fba:read');

    expect((await as(employeeUser).get('/api/fba-shipments')).status).toBe(200);
    expect((await as(employeeUser).get('/api/fba-shipments/categories')).status).toBe(
      200,
    );
    expect(
      (await as(employeeUser).post('/api/fba-shipments').send({})).status,
    ).toBe(403);
  });

  it('create opens recording an arrival', async () => {
    await grant('fba:create');

    const res = await as(employeeUser).post('/api/fba-shipments').send({
      categoryId: category.id,
      clientId: client.id,
      barcode: 'FBA-NEW',
      size: 'L',
      count: 2,
    });

    expect(res.status).toBe(201);
  });

  it('update opens marking one gone', async () => {
    const consignment = await fbaConsignment();
    await grant('fba:update');

    const res = await as(employeeUser).post(
      `/api/fba-shipments/${consignment.id}/dispatch`,
    );

    expect(res.status).not.toBe(403);
  });

  it('update does not open voiding', async () => {
    const consignment = await fbaConsignment();
    await grant('fba:update');

    const res = await as(employeeUser).post(
      `/api/fba-shipments/${consignment.id}/cancel`,
    );

    expect(res.status).toBe(403);
  });

  it('delete opens voiding, which is the soft delete of a consignment', async () => {
    // A separate test rather than a second grant in the one above: the grant
    // helper writes the row directly, and authorizeRoles has already cached the
    // first set by the time a second grant lands. See grantPermissions.
    const consignment = await fbaConsignment();
    await grant('fba:delete');

    const res = await as(employeeUser).post(
      `/api/fba-shipments/${consignment.id}/cancel`,
    );

    expect(res.status).not.toBe(403);
  });

  it('delete opens removing one outright', async () => {
    const consignment = await fbaConsignment();
    await grant('fba:delete');

    const res = await as(employeeUser).delete(
      `/api/fba-shipments/${consignment.id}`,
    );

    expect(res.status).not.toBe(403);
  });
});

describe('the modules are separate', () => {
  it('a shipments grant does not reach FBA, or the other way round', async () => {
    await grant('shipments:create', 'shipments:read');

    expect((await as(employeeUser).get('/api/fba-shipments')).status).toBe(403);
    expect(
      (await as(employeeUser).post('/api/fba-shipments').send({})).status,
    ).toBe(403);
  });

  it('nor does either reach inventory', async () => {
    await grant('shipments:read', 'fba:read');

    expect((await as(employeeUser).get('/api/products')).status).toBe(403);
  });
});

describe('what stays admin-only whatever is granted', () => {
  it('attaching or removing a billable service on a shipment', async () => {
    // A commercial decision, not warehouse work. Holding every shipments
    // permission does not buy it.
    await grant(
      'shipments:create',
      'shipments:read',
      'shipments:update',
      'shipments:delete',
    );

    expect(
      (await as(employeeUser).post(`/api/shipments/${shipment.id}/services`).send({}))
        .status,
    ).toBe(403);
    expect(
      (await as(employeeUser).delete(
        `/api/shipments/${shipment.id}/services/00000000-0000-0000-0000-000000000000`,
      )).status,
    ).toBe(403);
  });

  it('writing the FBA category list', async () => {
    // Reference data shaping every client's records.
    await grant('fba:create', 'fba:read', 'fba:update', 'fba:delete');

    expect(
      (await as(employeeUser).post('/api/fba-shipments/categories').send({ name: 'X' }))
        .status,
    ).toBe(403);
    expect(
      (await as(employeeUser).delete(`/api/fba-shipments/categories/${category.id}`))
        .status,
    ).toBe(403);
  });
});

describe('an admin and a client', () => {
  it('an admin does everything while holding nothing', async () => {
    expect((await as(admin).get('/api/shipments')).status).toBe(200);
    expect((await as(admin).get('/api/fba-shipments')).status).toBe(200);
    expect(
      (await as(admin).post(`/api/shipments/${shipment.id}/cancel`)).status,
    ).not.toBe(403);
  });

  it('a client still reads its own shipments and consignments', async () => {
    const { user: clientUser, client: ownClient } = await makeClient();

    expect(
      (await as(clientUser).get(`/api/shipments/client/${ownClient.id}`)).status,
    ).toBe(200);
    expect((await as(clientUser).get('/api/fba-shipments')).status).toBe(200);
  });
});
