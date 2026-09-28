/**
 * Bulk shipments — the three-step flow (create → prepare → dispatch).
 *
 * This replaced the old single-step FBA "record an arrival". The important
 * change is that a bulk shipment now DOES touch the warehouse: preparing it
 * reserves stock and dispatching it checks that stock out and bills the client
 * their single Bulk Shipment rate × the total units shipped. The old
 * "stays out of the warehouse" suite is gone on purpose.
 *
 * Any of the three steps can be done by the same person or by three different
 * people; what the tests pin is the state machine and the stock/billing effects,
 * not who performs each step.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeWarehouseScenario, makeEmployee } from '../factories/index.js';

let ctx;

/** The Bulk Shipment service + this client's single rate for it. */
const giveFbaRate = async (clientId, chargedPrice = '2.00') => {
  const service = await prisma.service.upsert({
    where: { code: 'FBA_DISPATCH' },
    update: {},
    create: {
      code: 'FBA_DISPATCH',
      description: 'Bulk shipment (per product)',
      ideaPrice: '0.00',
      unit: 'item',
    },
  });
  await prisma.clientService.create({
    data: { clientId, serviceId: service.id, chargedPrice, unit: 'item' },
  });
};

const makeCategory = async (name = `Cat-${Math.random().toString(36).slice(2, 8)}`) =>
  await prisma.fbaCategory.create({ data: { name } });

beforeEach(async () => {
  const scenario = await makeWarehouseScenario({ quantity: 100 });
  const category = await makeCategory();
  ctx = { ...scenario, category };
});

/** Step 1 body. */
const shell = (overrides = {}) => ({
  clientId: ctx.client.id,
  categoryId: ctx.category.id,
  destination: 'Amazon Global',
  deliveryNote: 'Handle with care',
  trackingId: 'TRK-BULK-1',
  ...overrides,
});

/** A line for step 2, drawn from the scenario's product + bin. */
const line = (quantity = 10, overrides = {}) => ({
  productId: ctx.product.id,
  sourceLocationId: ctx.location.id,
  quantity,
  ...overrides,
});

const createShell = (actor = ctx.admin, body = shell()) =>
  as(actor).post('/api/fba-shipments').send(body);

const stockNow = async () => {
  const s = await prisma.stockLevel.findUnique({ where: { id: ctx.stock.id } });
  return { current: s.currentQuantity, reserved: s.reservedQuantity };
};

// ─── Categories ─────────────────────────────────────────────────────────────

describe('categories', () => {
  it('are created, listed and de-duplicated', async () => {
    const res = await as(ctx.admin).post('/api/fba-shipments/categories').send({ name: 'Pallet' });
    expect(res.status).toBe(201);

    const dup = await as(ctx.admin).post('/api/fba-shipments/categories').send({ name: 'Pallet' });
    expect(dup.status).toBe(400);

    const list = await as(ctx.employeeUser).get('/api/fba-shipments/categories');
    expect(list.status).toBe(200);
    expect(list.body.some((c) => c.name === 'Pallet')).toBe(true);
  });

  it('cannot be deleted while a bulk shipment uses them', async () => {
    await createShell();
    const res = await as(ctx.admin).delete(`/api/fba-shipments/categories/${ctx.category.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be deleted/i);
  });
});

// ─── Step 1: create ───────────────────────────────────────────────────────────

describe('creating a bulk shipment', () => {
  it('opens a DRAFT with a server-issued BULK reference and the shell details', async () => {
    const res = await createShell();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.reference).toMatch(/^BULK-\d{4}-\d{6}$/);
    expect(res.body.destination).toBe('Amazon Global');
    expect(res.body.trackingId).toBe('TRK-BULK-1');
    expect(res.body.items).toEqual([]);
  });

  it('is open to an employee holding fba:create, refused to a client, and needs a session', async () => {
    expect((await createShell(ctx.employeeUser)).status).toBe(201);
    expect((await as(ctx.clientUser).post('/api/fba-shipments').send(shell())).status).toBe(403);
    expect((await anon().post('/api/fba-shipments').send(shell())).status).toBe(401);
  });

  it('requires a real client and category', async () => {
    expect((await createShell(ctx.admin, shell({ clientId: undefined }))).status).toBe(400);
    expect((await createShell(ctx.admin, shell({ categoryId: undefined }))).status).toBe(400);
    expect(
      (await createShell(ctx.admin, shell({ categoryId: '00000000-0000-0000-0000-000000000000' }))).status,
    ).toBe(400);
  });

  it('touches no stock yet', async () => {
    await createShell();
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });
});

// ─── Step 2: prepare (scan products in) ─────────────────────────────────────────

describe('adding products', () => {
  it('reserves stock and moves the shipment to PREPARING', async () => {
    const { body: created } = await createShell();

    const res = await as(ctx.employeeUser)
      .put(`/api/fba-shipments/${created.id}/items`)
      .send({ lines: [line(10)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PREPARING');
    expect(res.body.items).toHaveLength(1);
    expect(await stockNow()).toEqual({ current: 100, reserved: 10 });
  });

  it('replaces the line set and nets the reservation', async () => {
    const { body: created } = await createShell();
    await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(10)] });
    expect((await stockNow()).reserved).toBe(10);

    // Re-prepare with a smaller quantity: the old reservation is handed back first.
    await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(4)] });
    expect(await stockNow()).toEqual({ current: 100, reserved: 4 });
  });

  it('refuses more than the available stock', async () => {
    const { body: created } = await createShell();
    const res = await as(ctx.admin)
      .put(`/api/fba-shipments/${created.id}/items`)
      .send({ lines: [line(1000)] });
    expect(res.status).toBe(400);
    expect((await stockNow()).reserved).toBe(0);
  });

  it('an empty set hands the reservation back and returns to DRAFT', async () => {
    const { body: created } = await createShell();
    await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(10)] });

    const res = await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DRAFT');
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });

  it('needs fba:update — a client cannot add products', async () => {
    const { body: created } = await createShell();
    const res = await as(ctx.clientUser)
      .put(`/api/fba-shipments/${created.id}/items`)
      .send({ lines: [line(1)] });
    expect(res.status).toBe(403);
  });
});

// ─── Step 3: dispatch, and the charge ───────────────────────────────────────────

describe('dispatching', () => {
  const prepared = async (quantity = 10) => {
    const { body: created } = await createShell();
    await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(quantity)] });
    return created;
  };

  it('checks the stock out and marks it DISPATCHED', async () => {
    const created = await prepared(10);

    const res = await as(ctx.employeeUser).post(`/api/fba-shipments/${created.id}/dispatch`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPATCHED');
    // Reserved released, current down by the units shipped.
    expect(await stockNow()).toEqual({ current: 90, reserved: 0 });

    const checkouts = await prisma.inventoryLedger.count({
      where: { referenceId: created.reference, movementType: 'CHECKOUT' },
    });
    expect(checkouts).toBe(1);
  });

  it('charges the client rate × total units', async () => {
    await giveFbaRate(ctx.client.id, '2.00');
    const created = await prepared(10);

    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);

    const line0 = await prisma.invoiceLineItem.findFirst({
      where: { itemType: 'FBA_CHARGE' },
      orderBy: { dateOfService: 'desc' },
    });
    expect(Number(line0.quantity)).toBe(10);
    expect(Number(line0.totalPrice)).toBe(20); // 10 units × 2.00
  });

  it('charges nothing when the client has no Bulk Shipment rate', async () => {
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);

    const count = await prisma.invoiceLineItem.count({ where: { itemType: 'FBA_CHARGE' } });
    expect(count).toBe(0);
  });

  it('will not dispatch a shipment with no products', async () => {
    const { body: created } = await createShell();
    const res = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no products/i);
  });

  it('cannot be dispatched twice', async () => {
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    const again = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(again.status).toBe(400);
  });
});

// ─── Cancel / delete ────────────────────────────────────────────────────────────

describe('cancel and delete', () => {
  const prepared = async (quantity = 10) => {
    const { body: created } = await createShell();
    await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(quantity)] });
    return created;
  };

  it('cancelling a PREPARING shipment hands the reservation back', async () => {
    const created = await prepared(10);
    expect((await stockNow()).reserved).toBe(10);

    const res = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });

  it('deleting is refused to an employee, even one holding fba:delete', async () => {
    const created = (await createShell()).body;
    const res = await as(ctx.employeeUser).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(403);
  });

  it('deleting a PREPARING shipment releases its reservation too', async () => {
    const created = await prepared(10);
    const res = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(200);
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });

  it('deleting a dispatched shipment returns its stock and leaves its charge billed', async () => {
    await giveFbaRate(ctx.client.id, '2.00');
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(await stockNow()).toEqual({ current: 90, reserved: 0 });

    const res = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.fbaShipment.findUnique({ where: { id: created.id } })).toBeNull();
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'FBA_CHARGE' } })).toBe(1);

    const returned = await prisma.inventoryLedger.findFirst({
      where: { movementType: 'RETURN', referenceId: created.reference },
    });
    expect(returned.quantity).toBe(10);
  });
});

// ─── Editing ────────────────────────────────────────────────────────────────────

describe('editing a bulk shipment', () => {
  const prepared = async (quantity = 10) => {
    const { body: created } = await createShell();
    await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(quantity)] });
    return created;
  };

  it('lets an admin correct its details, clearing a field sent empty', async () => {
    const created = (await createShell()).body;
    const res = await as(ctx.admin)
      .put(`/api/fba-shipments/${created.id}`)
      .send({ destination: 'Amazon EU', trackingId: '' });
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe('Amazon EU');
    expect(res.body.trackingId).toBeNull();
    expect(res.body.deliveryNote).toBe('Handle with care');
  });

  it('is refused to an employee and a client', async () => {
    const created = (await createShell()).body;
    for (const actor of [ctx.employeeUser, ctx.clientUser]) {
      const res = await as(actor)
        .put(`/api/fba-shipments/${created.id}`)
        .send({ destination: 'X' });
      expect(res.status).toBe(403);
    }
  });

  it('lets an admin edit any field whatever the status, even once dispatched', async () => {
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    const other = await makeWarehouseScenario();

    const res = await as(ctx.admin)
      .put(`/api/fba-shipments/${created.id}`)
      .send({ clientId: other.client.id, trackingId: 'TRK-LATE' });
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(other.client.id);
    expect(res.body.trackingId).toBe('TRK-LATE');
    expect(res.body.status).toBe('DISPATCHED');
  });
});

// ─── Who sees what ──────────────────────────────────────────────────────────────

describe('who sees what', () => {
  it('a client sees only their own bulk shipments; staff see all', async () => {
    await createShell(); // ctx.client
    const other = await makeWarehouseScenario();
    const otherCat = ctx.category; // categories are shared
    await as(ctx.admin)
      .post('/api/fba-shipments')
      .send({ clientId: other.client.id, categoryId: otherCat.id });

    const staffList = await as(ctx.admin).get('/api/fba-shipments');
    expect(staffList.body.length).toBeGreaterThanOrEqual(2);

    const clientList = await as(ctx.clientUser).get('/api/fba-shipments');
    expect(clientList.body.every((s) => s.clientId === ctx.client.id)).toBe(true);
  });

  it('404s another client’s shipment rather than revealing it', async () => {
    const { body: mine } = await createShell();
    const otherClientUser = (await makeWarehouseScenario()).clientUser;
    const res = await as(otherClientUser).get(`/api/fba-shipments/${mine.id}`);
    expect(res.status).toBe(404);
  });
});
