/**
 * Bulk shipments — the three-step flow (create with a plan → pick → dispatch).
 *
 * This replaced the old single-step FBA "record an arrival". The important
 * change is that a bulk shipment now DOES touch the warehouse: preparing it
 * reserves stock and dispatching it checks that stock out and bills the client
 * their single Bulk Shipment rate × the total units shipped. The old
 * "stays out of the warehouse" suite is gone on purpose.
 *
 * The office plans the products and quantities when it creates the shipment;
 * the floor picks against that plan, and dispatch is refused until every line
 * is fully picked.
 *
 * Any of the three steps can be done by the same person or by three different
 * people; what the tests pin is the state machine and the stock/billing effects,
 * not who performs each step.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeWarehouseScenario, makeEmployee, makeClientService } from '../factories/index.js';
import billingServices from '../../logic/billing_services.js';

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

/** Step 1 with a plan: the shipment is created with its products. */
const createPlanned = (quantity = 10, actor = ctx.admin) =>
  createShell(actor, shell({ lines: [line(quantity)] }));

/** Step 2: sets absolute picked counts, one per line, in line order. */
const pick = (shipment, counts, actor = ctx.employeeUser) =>
  as(actor)
    .put(`/api/fba-shipments/${shipment.id}/picks`)
    .send({ picks: shipment.items.map((item, i) => ({ itemId: item.id, pickedQuantity: counts[i] })) });

const pickAll = (shipment, actor) => pick(shipment, shipment.items.map((i) => i.quantity), actor);

/** Planned and fully picked — ready to dispatch. */
const prepared = async (quantity = 10) => {
  const { body: created } = await createPlanned(quantity);
  await pickAll(created);
  return created;
};

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

  it('touches no stock when sent without products', async () => {
    await createShell();
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });
});

describe('creating with a plan', () => {
  it('reserves the planned stock and starts PREPARING with nothing picked', async () => {
    const res = await createPlanned(10);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PREPARING');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ quantity: 10, pickedQuantity: 0 });
    expect(await stockNow()).toEqual({ current: 100, reserved: 10 });
  });

  it('merges repeat lines for the same product and bin', async () => {
    const res = await createShell(ctx.admin, shell({ lines: [line(4), line(6)] }));
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(10);
  });

  it('refuses more than the available stock and leaves nothing behind', async () => {
    const res = await createPlanned(1000);
    expect(res.status).toBe(400);
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
    expect(await prisma.fbaShipment.count({ where: { clientId: ctx.client.id } })).toBe(0);
  });

  it('refuses a product belonging to another client', async () => {
    const other = await makeWarehouseScenario({ quantity: 5 });
    const res = await createShell(
      ctx.admin,
      shell({ lines: [line(1, { productId: other.product.id, sourceLocationId: other.location.id })] }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/another client/i);
  });
});

// ─── Changing the plan ─────────────────────────────────────────────────────────

describe('changing the plan', () => {
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

  it('keeps picks already made when the plan still covers them', async () => {
    const { body: created } = await createPlanned(10);
    await pick(created, [3]);

    const res = await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(5)] });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ quantity: 5, pickedQuantity: 3 });
  });

  it('lets the plan drop below what is picked, holding the extra until it is put back', async () => {
    const { body: created } = await createPlanned(10);
    await pick(created, [8]);

    const cut = await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [line(5)] });
    expect(cut.status).toBe(200);
    expect(cut.body.items[0]).toMatchObject({ quantity: 5, pickedQuantity: 8 });
    // The 3 extra are off the shelf, so they stay held.
    expect((await stockNow()).reserved).toBe(8);

    const refused = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/to put back/i);
    expect(refused.body.error).toContain(`${ctx.product.skuCode} × 3`);

    const back = await pick(cut.body, [5]);
    expect(back.body.items[0]).toMatchObject({ pickedQuantity: 5, putBackQuantity: 3 });
    expect((await stockNow()).reserved).toBe(5);
    expect((await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`)).status).toBe(200);
  });

  it('keeps a dropped picked line at zero until its goods are put back, then lets it go', async () => {
    const { body: created } = await createPlanned(10);
    await pick(created, [4]);

    const dropped = await as(ctx.admin).put(`/api/fba-shipments/${created.id}/items`).send({ lines: [] });
    expect(dropped.status).toBe(200);
    expect(dropped.body.status).toBe('PREPARING');
    expect(dropped.body.items).toEqual([expect.objectContaining({ quantity: 0, pickedQuantity: 4 })]);
    expect((await stockNow()).reserved).toBe(4);

    const back = await pick(dropped.body, [0]);
    expect(back.status).toBe(200);
    expect(back.body.items).toEqual([]);
    expect(back.body.status).toBe('DRAFT');
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });

  it('adds a new product unpicked, and dispatch waits for it', async () => {
    const { body: created } = await createPlanned(4);
    await pickAll(created);
    const other = await prisma.product.create({
      data: { clientId: ctx.client.id, skuCode: 'NEW-SKU', productName: 'New thing' },
    });
    await prisma.stockLevel.create({ data: { productId: other.id, locationId: ctx.location.id, currentQuantity: 20 } });

    const res = await as(ctx.admin)
      .put(`/api/fba-shipments/${created.id}/items`)
      .send({ lines: [line(4), line(2, { productId: other.id })] });
    expect(res.status).toBe(200);
    const added = res.body.items.find((i) => i.productId === other.id);
    expect(added.pickedQuantity).toBe(0);

    const refused = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/still to pick: NEW-SKU 0\/2/);
  });
});

// ─── Step 2: pick against the plan ──────────────────────────────────────────────

describe('picking', () => {
  it('records lowering a count as a put-back, keeping a running total per line', async () => {
    const { body: created } = await createPlanned(10);
    await pick(created, [6]);
    await pick(created, [2]); // 4 back
    await pick(created, [5]);
    const res = await pick(created, [3]); // 2 more back

    expect(res.body.items[0]).toMatchObject({ pickedQuantity: 3, putBackQuantity: 6 });
    const logged = await prisma.auditLog.count({ where: { action: 'FBA_SHIPMENT_PUT_BACK' } });
    expect(logged).toBe(2);
  });

  it('records absolute picked counts without touching stock', async () => {
    const { body: created } = await createPlanned(10);

    const res = await pick(created, [4]);
    expect(res.status).toBe(200);
    expect(res.body.items[0].pickedQuantity).toBe(4);

    // Re-sending the same count does not add to it.
    expect((await pick(created, [4])).body.items[0].pickedQuantity).toBe(4);
    expect(await stockNow()).toEqual({ current: 100, reserved: 10 });
  });

  it('refuses picking more than was planned', async () => {
    const { body: created } = await createPlanned(10);
    const res = await pick(created, [11]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only 10 planned/i);
  });

  it('refuses a line that is not on the shipment', async () => {
    const { body: created } = await createPlanned(10);
    const res = await as(ctx.employeeUser)
      .put(`/api/fba-shipments/${created.id}/picks`)
      .send({ picks: [{ itemId: '00000000-0000-0000-0000-000000000000', pickedQuantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('refuses picking a shipment with no plan', async () => {
    const { body: created } = await createShell();
    const res = await as(ctx.employeeUser)
      .put(`/api/fba-shipments/${created.id}/picks`)
      .send({ picks: [{ itemId: '00000000-0000-0000-0000-000000000000', pickedQuantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/being prepared/i);
  });

  it('needs fba:update — a client cannot pick', async () => {
    const { body: created } = await createPlanned(10);
    expect((await pickAll(created, ctx.clientUser)).status).toBe(403);
  });
});

// ─── Step 3: dispatch, and the charge ───────────────────────────────────────────

describe('dispatching', () => {
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

  it('is refused until every line is fully picked', async () => {
    const { body: created } = await createPlanned(10);
    await pick(created, [6]);

    const res = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/still to pick/i);
    expect(res.body.error).toContain('6/10');
    expect(await stockNow()).toEqual({ current: 100, reserved: 10 });
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
  it('cancelling a PREPARING shipment hands the reservation back', async () => {
    const { body: created } = await createPlanned(10);
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
    const { body: created } = await createPlanned(10);
    const res = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(200);
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });

  it('voids whatever is picked, keeping picked goods held and on record until put back', async () => {
    const { body: created } = await createPlanned(10);
    await pick(created, [4]);

    const voided = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/cancel`);
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('CANCELLED');
    expect(voided.body.items[0]).toMatchObject({ quantity: 10, pickedQuantity: 4 });
    // The 6 never picked go back at once; the 4 picked stay held.
    expect((await stockNow()).reserved).toBe(4);

    // Deleting would lose track of them, so it waits.
    const deleted = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(deleted.status).toBe(400);
    expect(deleted.body.error).toMatch(/put them back first/i);

    // A voided shipment takes put-backs only.
    expect((await pick(voided.body, [5])).status).toBe(400);
    const back = await pick(voided.body, [0]);
    expect(back.status).toBe(200);
    expect(back.body.items[0]).toMatchObject({ pickedQuantity: 0, putBackQuantity: 4 });
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });

    expect((await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`)).status).toBe(200);
  });

  it('deleting a dispatched shipment returns its stock and takes its charge off the invoice', async () => {
    await giveFbaRate(ctx.client.id, '2.00');
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(await stockNow()).toEqual({ current: 90, reserved: 0 });
    const charge = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'FBA_CHARGE' } });
    expect(charge.fbaShipmentId).toBe(created.id);

    const res = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.chargesRemoved).toBe(20);
    expect(await prisma.fbaShipment.findUnique({ where: { id: created.id } })).toBeNull();
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'FBA_CHARGE' } })).toBe(0);
    const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: charge.invoiceId } });
    expect(Number(invoice.totalAmount)).toBe(0);

    const returned = await prisma.inventoryLedger.findFirst({
      where: { movementType: 'RETURN', referenceId: created.reference },
    });
    expect(returned.quantity).toBe(10);
  });

  it('deleting a dispatched shipment is refused once its invoice is paid, and nothing moves', async () => {
    await giveFbaRate(ctx.client.id, '2.00');
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    const charge = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'FBA_CHARGE' } });
    await prisma.monthlyInvoice.update({
      where: { id: charge.invoiceId },
      data: { status: 'PAID', paidAt: new Date() },
    });

    const res = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been paid/i);
    expect(await prisma.fbaShipment.findUnique({ where: { id: created.id } })).not.toBeNull();
    expect(await stockNow()).toEqual({ current: 90, reserved: 0 });
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'FBA_CHARGE' } })).toBe(1);
  });

  it('deleting after a partial return puts back only what is still out', async () => {
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    await as(ctx.employeeUser)
      .post(`/api/fba-shipments/${created.id}/items/${created.items[0].id}/return`)
      .send({ quantity: 4 });
    expect(await stockNow()).toEqual({ current: 94, reserved: 0 });

    const res = await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(res.status).toBe(200);
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });
  });
});

// ─── After dispatch ──────────────────────────────────────────────────────────

describe('returning goods after dispatch', () => {
  const dispatched = async (quantity = 10) => {
    await giveFbaRate(ctx.client.id, '2.00');
    const created = await prepared(quantity);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    return created;
  };
  const giveReturnRate = async (chargedPrice = '1.50') => {
    const service = await billingServices.ensureReturnService();
    await makeClientService(ctx.client.id, service.id, { chargedPrice, unit: 'item' });
  };
  const returnLine = (actor, created, body) =>
    as(actor)
      .post(`/api/fba-shipments/${created.id}/items/${created.items[0].id}/return`)
      .send(body);

  it('puts part of a line back on its shelf and leaves the dispatch charge alone', async () => {
    const created = await dispatched(10);

    const res = await returnLine(ctx.employeeUser, created, { quantity: 3, reason: 'Damaged' });
    expect(res.status).toBe(200);
    expect(res.body.returnCharge).toBeNull();
    expect(res.body.shipment.items[0].returnedQuantity).toBe(3);
    expect(await stockNow()).toEqual({ current: 93, reserved: 0 });

    const movement = await prisma.inventoryLedger.findFirst({
      where: { movementType: 'RETURN', referenceId: created.reference },
    });
    expect(movement.quantity).toBe(3);
    expect(movement.notes).toBe('Damaged');

    const charge = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'FBA_CHARGE' } });
    expect(Number(charge.totalPrice)).toBe(20);
  });

  it('never returns more than is still out', async () => {
    const created = await dispatched(10);
    expect((await returnLine(ctx.admin, created, { quantity: 11 })).status).toBe(400);
    await returnLine(ctx.admin, created, { quantity: 7 });
    const over = await returnLine(ctx.admin, created, { quantity: 4 });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/Only 3 of this line is still out/);
    expect((await returnLine(ctx.admin, created, { quantity: 0 })).status).toBe(400);
  });

  it('is refused before dispatch', async () => {
    const created = await prepared(10);
    const res = await returnLine(ctx.admin, created, { quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only a dispatched/);
  });

  it('adds a return fee only when an admin asks and the client has a rate', async () => {
    await giveReturnRate('1.50');
    const created = await dispatched(10);

    // Not asked: nothing charged.
    expect((await returnLine(ctx.admin, created, { quantity: 1 })).body.returnCharge).toBeNull();
    // Asked by an employee: ignored.
    expect(
      (await returnLine(ctx.employeeUser, created, { quantity: 1, chargeReturn: true })).body.returnCharge,
    ).toBeNull();
    // Asked by an admin: its own line beside the untouched dispatch charge.
    const res = await returnLine(ctx.admin, created, { quantity: 2, chargeReturn: true });
    expect(res.body.returnCharge).toBe(3);
    const fee = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'MANUAL_CHARGE' } });
    expect(Number(fee.totalPrice)).toBe(3);
    expect(fee.fbaShipmentId).toBe(created.id);
    const charge = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'FBA_CHARGE' } });
    expect(Number(charge.totalPrice)).toBe(20);

    // Deleting the shipment later takes its dispatch charge off but keeps the fee.
    await as(ctx.admin).delete(`/api/fba-shipments/${created.id}`);
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'FBA_CHARGE' } })).toBe(0);
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'MANUAL_CHARGE' } })).toBe(1);
  });

  it('needs fba:update — a client cannot return goods', async () => {
    const created = await dispatched(10);
    expect((await returnLine(ctx.clientUser, created, { quantity: 1 })).status).toBe(403);
  });
});

describe('the tracking number', () => {
  const setTracking = (actor, created, trackingId) =>
    as(actor).put(`/api/fba-shipments/${created.id}/tracking`).send({ trackingId });

  it('can be recorded by an employee after dispatch, and cleared', async () => {
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);

    const res = await setTracking(ctx.employeeUser, created, '  JD0001 ');
    expect(res.status).toBe(200);
    expect(res.body.trackingId).toBe('JD0001');

    const cleared = await setTracking(ctx.employeeUser, created, '');
    expect(cleared.body.trackingId).toBeNull();
  });

  it('is refused once voided, and to a client', async () => {
    const { body: created } = await createPlanned(10);
    expect((await setTracking(ctx.clientUser, created, 'X1')).status).toBe(403);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/cancel`);
    const res = await setTracking(ctx.admin, created, 'X1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voided/i);
  });
});

// ─── Editing ────────────────────────────────────────────────────────────────────

describe('editing a bulk shipment', () => {
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

  it('lets an admin edit its details whatever the status, even once dispatched', async () => {
    const created = await prepared(10);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    const otherCategory = await makeCategory();

    const res = await as(ctx.admin)
      .put(`/api/fba-shipments/${created.id}`)
      .send({ categoryId: otherCategory.id, trackingId: 'TRK-LATE' });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBe(otherCategory.id);
    expect(res.body.trackingId).toBe('TRK-LATE');
    expect(res.body.status).toBe('DISPATCHED');
  });
});

describe('moving a bulk shipment to another client', () => {
  /** An ordinary catalogue service with a rate for each client given. */
  const serviceRatedFor = async (clientIds, chargedPrices) => {
    const service = await prisma.service.create({
      data: { description: `Svc-${Math.random().toString(36).slice(2, 8)}`, ideaPrice: '0.00', unit: 'item' },
    });
    for (const [i, clientId] of clientIds.entries()) {
      await prisma.clientService.create({
        data: { clientId, serviceId: service.id, chargedPrice: chargedPrices[i], unit: 'item' },
      });
    }
    return service;
  };

  const move = (shipment, clientId, confirmClientReset) =>
    as(ctx.admin)
      .put(`/api/fba-shipments/${shipment.id}`)
      .send({ clientId, ...(confirmClientReset ? { confirmClientReset } : {}) });

  it('asks for confirmation first, listing what would be removed, and changes nothing', async () => {
    const other = await makeWarehouseScenario();
    const service = await serviceRatedFor([ctx.client.id], ['3.50']);
    const { body: created } = await createShell(
      ctx.admin,
      shell({ lines: [line(10)], services: [{ serviceId: service.id, quantity: 2 }] }),
    );

    const res = await move(created, other.client.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFIRM_CLIENT_RESET');
    expect(res.body.removes.products).toEqual([
      expect.objectContaining({ sku: ctx.product.skuCode, quantity: 10, pickedQuantity: 0 }),
    ]);
    expect(res.body.removes.services).toHaveLength(1);

    const unchanged = await prisma.fbaShipment.findUnique({
      where: { id: created.id },
      include: { items: true, services: true },
    });
    expect(unchanged.clientId).toBe(ctx.client.id);
    expect(unchanged.items).toHaveLength(1);
    expect(unchanged.services).toHaveLength(1);
    expect((await stockNow()).reserved).toBe(10);
  });

  it('once confirmed, resets what does not belong and keeps services the new client has a rate for', async () => {
    const other = await makeWarehouseScenario();
    const shared = await serviceRatedFor([ctx.client.id, other.client.id], ['3.50', '5.00']);
    const oldOnly = await serviceRatedFor([ctx.client.id], ['1.00']);
    const { body: created } = await createShell(
      ctx.admin,
      shell({
        lines: [line(10)],
        services: [
          { serviceId: shared.id, quantity: 2 },
          { serviceId: oldOnly.id, quantity: 1 },
        ],
      }),
    );

    const res = await move(created, other.client.id, true);
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(other.client.id);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.items).toEqual([]);
    expect(await stockNow()).toEqual({ current: 100, reserved: 0 });

    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].serviceId).toBe(shared.id);
    expect(Number(res.body.services[0].quantity)).toBe(2);
    const rate = await prisma.clientService.findFirst({
      where: { clientId: other.client.id, serviceId: shared.id },
    });
    expect(res.body.services[0].clientServiceId).toBe(rate.id);
  });

  it('moves straight away when nothing would be removed', async () => {
    const other = await makeWarehouseScenario();
    const shared = await serviceRatedFor([ctx.client.id, other.client.id], ['3.50', '5.00']);
    const { body: created } = await createShell(
      ctx.admin,
      shell({ services: [{ serviceId: shared.id, quantity: 2 }] }),
    );

    const res = await move(created, other.client.id);
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(other.client.id);
    expect(res.body.services).toHaveLength(1);
  });

  it('can be done by an employee holding fba:create or fba:update, with the same confirmation', async () => {
    const other = await makeWarehouseScenario();
    const { user: creator } = await makeEmployee({ user: { permissions: ['fba:read', 'fba:create'] } });
    const { user: updater } = await makeEmployee({ user: { permissions: ['fba:read', 'fba:update'] } });

    // The update-only employee moves an empty shell; nothing to lose, no 409.
    const { body: shell1 } = await createShell();
    const moved = await as(updater).put(`/api/fba-shipments/${shell1.id}/client`).send({ clientId: other.client.id });
    expect(moved.status).toBe(200);

    const { body: created } = await createPlanned(10);
    const put = (body) => as(creator).put(`/api/fba-shipments/${created.id}/client`).send(body);

    const unconfirmed = await put({ clientId: other.client.id });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe('CONFIRM_CLIENT_RESET');

    // Only the client moves; nothing else in the body is applied.
    const res = await put({ clientId: other.client.id, confirmClientReset: true, destination: 'Somewhere else' });
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(other.client.id);
    expect(res.body.destination).toBe('Amazon Global');
    expect(res.body.items).toEqual([]);
  });

  it('is refused to an employee with neither permission, and to a client', async () => {
    const other = await makeWarehouseScenario();
    const { body: created } = await createShell();
    const put = (actor) =>
      as(actor)
        .put(`/api/fba-shipments/${created.id}/client`)
        .send({ clientId: other.client.id, confirmClientReset: true });

    const { user: readOnly } = await makeEmployee({ user: { permissions: ['fba:read', 'fba:delete'] } });
    expect((await put(readOnly)).status).toBe(403);
    expect((await put(ctx.clientUser)).status).toBe(403);
  });

  it('is refused on the employee route once dispatched', async () => {
    const other = await makeWarehouseScenario();
    const dispatched = await prepared(5);
    await as(ctx.admin).post(`/api/fba-shipments/${dispatched.id}/dispatch`);
    const res = await as(ctx.employeeUser)
      .put(`/api/fba-shipments/${dispatched.id}/client`)
      .send({ clientId: other.client.id, confirmClientReset: true });
    expect(res.status).toBe(400);
  });

  it('is refused to everyone once a single unit is picked, confirmed or not', async () => {
    const other = await makeWarehouseScenario();
    const { body: created } = await createPlanned(10);
    await pick(created, [1]);

    const byAdmin = await move(created, other.client.id, true);
    expect(byAdmin.status).toBe(400);
    expect(byAdmin.body.error).toMatch(/picking has started/i);

    const byEmployee = await as(ctx.employeeUser)
      .put(`/api/fba-shipments/${created.id}/client`)
      .send({ clientId: other.client.id, confirmClientReset: true });
    expect(byEmployee.status).toBe(400);

    const unchanged = await prisma.fbaShipment.findUnique({
      where: { id: created.id },
      include: { items: true },
    });
    expect(unchanged.clientId).toBe(ctx.client.id);
    expect(unchanged.items[0].pickedQuantity).toBe(1);
    expect((await stockNow()).reserved).toBe(10);
  });

  it('is refused for a dispatched shipment, confirmed or not', async () => {
    const other = await makeWarehouseScenario();
    const dispatched = await prepared(5);
    await as(ctx.admin).post(`/api/fba-shipments/${dispatched.id}/dispatch`);

    const res = await move(dispatched, other.client.id, true);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dispatched/i);
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

// ─── Delivery details ───────────────────────────────────────────────────────────

describe('delivery details', () => {
  const details = {
    dispatchMode: 'EVRI NEXT DAY',
    staffNote: 'Fragile — double box',
    orderReference: 'PO-4471',
    deliveryAddress: 'Unit 4, Big Warehouse Park\nDoncaster',
    deliveryPostcode: 'DN4 5NL',
    deliveryContact: '01302 555 010',
    vehicleRegistration: 'AB12 CDE',
    palletCount: 2,
  };

  it('are stored on create, with boxes per line', async () => {
    const res = await createShell(ctx.admin, shell({ ...details, lines: [line(10, { boxes: 2 })] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(details);
    expect(res.body.items[0].boxes).toBe(2);
  });

  it('refuses a pallet count that is not a whole number', async () => {
    const res = await createShell(ctx.admin, shell({ palletCount: 1.5 }));
    expect(res.status).toBe(400);
  });

  it('can be corrected by an admin, clearing one sent empty', async () => {
    const { body: created } = await createShell(ctx.admin, shell(details));
    const res = await as(ctx.admin)
      .put(`/api/fba-shipments/${created.id}`)
      .send({ dispatchMode: 'DPD', vehicleRegistration: '' });
    expect(res.status).toBe(200);
    expect(res.body.dispatchMode).toBe('DPD');
    expect(res.body.vehicleRegistration).toBeNull();
    expect(res.body.orderReference).toBe('PO-4471');
  });
});

// ─── Attached services ──────────────────────────────────────────────────────────

describe('services', () => {
  /** An ordinary catalogue service and this client's agreed rate for it. */
  const giveServiceRate = async (clientId, chargedPrice = '3.50', description = 'Labelling') => {
    const service = await prisma.service.create({
      data: { description, ideaPrice: '0.00', unit: 'item' },
    });
    await prisma.clientService.create({
      data: { clientId, serviceId: service.id, chargedPrice, unit: 'item' },
    });
    return service;
  };

  it('attaches services unpriced, and charges them at the rate in force on dispatch', async () => {
    const service = await giveServiceRate(ctx.client.id, '3.50');
    const res = await createShell(
      ctx.admin,
      shell({ lines: [line(10)], services: [{ serviceId: service.id, quantity: 4 }] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].appliedUnitPrice).toBeNull();
    expect(Number(res.body.services[0].quantity)).toBe(4);

    // The rate changes before the goods go.
    await prisma.clientService.updateMany({
      where: { clientId: ctx.client.id, serviceId: service.id },
      data: { chargedPrice: '6.00' },
    });
    await pickAll(res.body);
    const dispatched = await as(ctx.admin).post(`/api/fba-shipments/${res.body.id}/dispatch`);
    expect(dispatched.status).toBe(200);

    const charged = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'AUTOMATED_SERVICE' } });
    expect(Number(charged.totalPrice)).toBe(24); // 4 × 6.00, not 4 × 3.50
    const recorded = await prisma.fbaShipmentService.findFirst({ where: { fbaShipmentId: res.body.id } });
    expect(Number(recorded.appliedUnitPrice)).toBe(6);
  });

  it('will not dispatch while an attached service has lost its rate', async () => {
    const service = await giveServiceRate(ctx.client.id, '3.50', 'Wrapping');
    const { body: created } = await createShell(
      ctx.admin,
      shell({ lines: [line(10)], services: [{ serviceId: service.id, quantity: 1 }] }),
    );
    await pickAll(created);
    await prisma.clientService.deleteMany({ where: { clientId: ctx.client.id, serviceId: service.id } });

    const res = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Wrapping no longer has a rate/);
    expect(await stockNow()).toEqual({ current: 100, reserved: 10 });
  });

  it('refuses a service the client has no rate for', async () => {
    const service = await prisma.service.create({
      data: { description: 'Unpriced', ideaPrice: '0.00', unit: 'item' },
    });
    const res = await createShell(ctx.admin, shell({ services: [{ serviceId: service.id, quantity: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not set up for this client/i);
  });

  it('are still checked against the shipment’s client when changed', async () => {
    const other = await makeWarehouseScenario();
    const foreign = await giveServiceRate(other.client.id, '9.00', 'Other client only');
    const { body: created } = await createPlanned(10);

    const res = await as(ctx.employeeUser)
      .put(`/api/fba-shipments/${created.id}/services`)
      .send({ services: [{ serviceId: foreign.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not set up for this client/i);
  });

  it('refuses the Bulk Shipment service itself — it is charged on dispatch already', async () => {
    await giveFbaRate(ctx.client.id, '2.00');
    const fba = await prisma.service.findUnique({ where: { code: 'FBA_DISPATCH' } });
    const res = await createShell(ctx.admin, shell({ services: [{ serviceId: fba.id, quantity: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/charged automatically/i);
  });

  it('charges each attached service on dispatch, beside the unit rate', async () => {
    await giveFbaRate(ctx.client.id, '2.00');
    const service = await giveServiceRate(ctx.client.id, '3.50');
    const { body: created } = await createShell(
      ctx.admin,
      shell({ lines: [line(10)], services: [{ serviceId: service.id, quantity: 4 }] }),
    );
    await pickAll(created);

    const res = await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    expect(res.status).toBe(200);

    const serviceLine = await prisma.invoiceLineItem.findFirst({ where: { itemType: 'AUTOMATED_SERVICE' } });
    expect(Number(serviceLine.totalPrice)).toBe(14); // 4 × 3.50
    expect(serviceLine.description).toContain(created.reference);
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'FBA_CHARGE' } })).toBe(1);
  });

  it('are changed by anyone with fba:update, and only before dispatch', async () => {
    const service = await giveServiceRate(ctx.client.id);
    const { body: created } = await createPlanned(10);
    const body = { services: [{ serviceId: service.id, quantity: 2 }] };
    const put = (actor, payload = body) =>
      as(actor).put(`/api/fba-shipments/${created.id}/services`).send(payload);

    const { user: readOnly } = await makeEmployee({ user: { permissions: ['fba:read'] } });
    expect((await put(readOnly)).status).toBe(403);
    expect((await put(ctx.clientUser)).status).toBe(403);

    const { user: updater } = await makeEmployee({ user: { permissions: ['fba:read', 'fba:update'] } });
    const res = await put(updater);
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);

    // Their options come from the same list the create form uses.
    const options = await as(updater).get(`/api/fba-shipments/client-services/${ctx.client.id}`);
    expect(options.status).toBe(200);

    await pickAll(created);
    await as(ctx.admin).post(`/api/fba-shipments/${created.id}/dispatch`);
    const late = await put(ctx.admin, { services: [] });
    expect(late.status).toBe(400);
  });

  it('lists what can be attached, without prices for an employee', async () => {
    await giveServiceRate(ctx.client.id, '3.50', 'Labelling');
    await giveFbaRate(ctx.client.id, '2.00');

    const staff = await as(ctx.employeeUser).get(`/api/fba-shipments/client-services/${ctx.client.id}`);
    expect(staff.status).toBe(200);
    expect(staff.body.map((s) => s.description)).toEqual(['Labelling']);
    expect(staff.body[0].chargedPrice).toBeUndefined();

    const admin = await as(ctx.admin).get(`/api/fba-shipments/client-services/${ctx.client.id}`);
    expect(Number(admin.body[0].chargedPrice)).toBe(3.5);
  });
});

// ─── Delivery note ──────────────────────────────────────────────────────────────

describe('delivery note', () => {
  const pdf = (actor, id) =>
    as(actor)
      .get(`/api/fba-shipments/${id}/delivery-note`)
      .buffer(true)
      .parse((res, done) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  it('renders a PDF for staff and the owning client', async () => {
    const { body: created } = await createShell(
      ctx.admin,
      shell({ dispatchMode: 'EVRI NEXT DAY', lines: [line(10, { boxes: 1 })] }),
    );

    for (const actor of [ctx.employeeUser, ctx.clientUser]) {
      const res = await pdf(actor, created.id);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('404s another client’s delivery note', async () => {
    const { body: created } = await createPlanned(10);
    const other = (await makeWarehouseScenario()).clientUser;
    expect((await pdf(other, created.id)).status).toBe(404);
  });
});

// ─── Finding products ───────────────────────────────────────────────────────────

describe('finding products to plan or pick', () => {
  const lookup = (user) => as(user).get('/api/products/lookup/barcode/NOTHING-HERE');

  it('is open to an employee who can create or pick bulk shipments, without inventory access', async () => {
    for (const permissions of [['fba:read', 'fba:create'], ['fba:read', 'fba:update']]) {
      const { user } = await makeEmployee({ user: { permissions } });
      // 404 rather than 403: the route was reached, the code simply is not one.
      expect((await lookup(user)).status).not.toBe(403);
    }
  });

  it('stays closed to an employee who can only read bulk shipments', async () => {
    const { user } = await makeEmployee({ user: { permissions: ['fba:read'] } });
    expect((await lookup(user)).status).toBe(403);
  });
});
