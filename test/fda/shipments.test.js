/**
 * FDA consignments.
 *
 * A deliberately smaller flow than an ordinary shipment: goods arrive, are
 * recorded by hand, and leave. Nothing is scanned, nothing is put away, no stock
 * level moves and no ledger entry is written — the goods were never in our
 * inventory, they pass through. What is billed is the passing through, per item,
 * when they go.
 *
 * The assertions that matter most are the ones proving it stays out of the
 * warehouse: an FDA consignment must not touch stock or the ledger, or the two
 * flows start corrupting each other's numbers.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import { makeWarehouseScenario } from '../factories/index.js';

/** The FDA charge service, plus this client's agreed per-item rate for it. */
const giveFdaRate = async (clientId, chargedPrice = '3.00') => {
  const service = await prisma.service.upsert({
    where: { code: 'FDA_DISPATCH' },
    update: {},
    create: {
      code: 'FDA_DISPATCH',
      description: 'FDA consignment (per item)',
      ideaPrice: '0.00',
      unit: 'item',
    },
  });
  return await prisma.clientService.create({
    data: { clientId, serviceId: service.id, chargedPrice, unit: 'item' },
  });
};

const arrange = async () => {
  const scenario = await makeWarehouseScenario();
  const category = await prisma.fdaCategory.create({ data: { name: 'Chilled' } });
  return { ...scenario, category };
};

const arrival = (ctx, overrides = {}) => ({
  categoryId: ctx.category.id,
  clientId: ctx.client.id,
  barcode: 'FDA0001234',
  size: 'Large',
  count: 12,
  ...overrides,
});

const invoiceFor = (clientId) =>
  prisma.monthlyInvoice.findFirst({
    where: { clientId },
    include: { lineItems: true },
  });

describe('categories', () => {
  it('are created by an admin', async () => {
    const { admin } = await arrange();

    const res = await as(admin).post('/api/fda-shipments/categories').send({ name: 'Ambient' });

    expect(res.status).toBe(201);
  });

  it('are readable by staff, who have to choose one', async () => {
    const { employeeUser } = await arrange();
    expect((await as(employeeUser).get('/api/fda-shipments/categories')).status).toBe(200);
  });

  it('are not created by an employee', async () => {
    const { employeeUser } = await arrange();

    const res = await as(employeeUser)
      .post('/api/fda-shipments/categories')
      .send({ name: 'Sneaky' });

    expect(res.status).toBe(403);
  });

  it('refuse a duplicate name', async () => {
    const { admin } = await arrange();

    const res = await as(admin).post('/api/fda-shipments/categories').send({ name: 'Chilled' });

    expect(res.status).toBe(400);
    expect(await prisma.fdaCategory.count({ where: { name: 'Chilled' } })).toBe(1);
  });

  it('refuse a blank name', async () => {
    const { admin } = await arrange();
    expect(
      (await as(admin).post('/api/fda-shipments/categories').send({ name: '   ' })).status
    ).toBe(400);
  });

  it('cannot be deleted while consignments still use them', async () => {
    // Deleting would either orphan their history or cascade it away, and both
    // lose the record of what was handled and billed.
    const ctx = await arrange();
    await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    const res = await as(ctx.admin).delete(`/api/fda-shipments/categories/${ctx.category.id}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be deleted/i);
  });

  it('are deletable when nothing references them', async () => {
    const { admin } = await arrange();
    const spare = await prisma.fdaCategory.create({ data: { name: 'Unused' } });

    expect((await as(admin).delete(`/api/fda-shipments/categories/${spare.id}`)).status).toBe(200);
  });

  it('route "categories" to the list, not to a consignment id', async () => {
    const { admin } = await arrange();
    expect((await as(admin).get('/api/fda-shipments/categories')).status).toBe(200);
  });
});

describe('recording an arrival', () => {
  it('stores what was typed in', async () => {
    const ctx = await arrange();

    const res = await as(ctx.employeeUser).post('/api/fda-shipments').send(arrival(ctx));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('RECEIVED');
    expect(res.body.count).toBe(12);
    expect(res.body.size).toBe('Large');
  });

  it('is open to employees, who are the ones receiving goods', async () => {
    const ctx = await arrange();
    expect((await as(ctx.employeeUser).post('/api/fda-shipments').send(arrival(ctx))).status).toBe(201);
  });

  it('is closed to clients', async () => {
    const ctx = await arrange();
    expect((await as(ctx.clientUser).post('/api/fda-shipments').send(arrival(ctx))).status).toBe(403);
  });

  it('refuses an anonymous request', async () => {
    const ctx = await arrange();
    expect((await anon().post('/api/fda-shipments').send(arrival(ctx))).status).toBe(401);
  });

  it('strips spaces from the barcode, as it is read off a label', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin)
      .post('/api/fda-shipments')
      .send(arrival(ctx, { barcode: ' FDA 0001 234 ' }));

    expect(res.body.barcode).toBe('FDA0001234');
  });

  it('refuses a count of zero or less', async () => {
    const ctx = await arrange();

    expect((await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { count: 0 }))).status).toBe(400);
    expect((await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { count: -5 }))).status).toBe(400);
  });

  it('refuses a fractional count', async () => {
    const ctx = await arrange();
    expect((await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { count: 2.5 }))).status).toBe(400);
  });

  it('refuses a missing barcode or size', async () => {
    const ctx = await arrange();

    expect((await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { barcode: '' }))).status).toBe(400);
    expect((await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { size: '' }))).status).toBe(400);
  });

  it('refuses a category that does not exist', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin)
      .post('/api/fda-shipments')
      .send(arrival(ctx, { categoryId: '00000000-0000-0000-0000-000000000000' }));

    expect(res.status).toBe(400);
  });

  it('opens no invoice — nothing is billed until it leaves', async () => {
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id);

    await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    expect(await prisma.monthlyInvoice.count({ where: { clientId: ctx.client.id } })).toBe(0);
  });
});

describe('dispatching, and the charge', () => {
  it('bills count times the agreed rate', async () => {
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id, '3.00');
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { count: 12 }));

    const res = await as(ctx.employeeUser).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    expect(res.status).toBe(200);
    const invoice = await invoiceFor(ctx.client.id);
    const charges = invoice.lineItems.filter((l) => l.itemType === 'FDA_CHARGE');
    expect(charges).toHaveLength(1);
    expect(Number(charges[0].quantity)).toBe(12);
    expect(Number(charges[0].totalPrice)).toBe(36);
    expect(Number(invoice.totalAmount)).toBe(36);
  });

  it('uses its own line type, kept separate from ordinary dispatch', async () => {
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id);
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    const invoice = await invoiceFor(ctx.client.id);
    expect(invoice.lineItems[0].itemType).toBe('FDA_CHARGE');
  });

  it('charges nothing when the client has no FDA rate', async () => {
    // A real arrangement, not an error — the same treatment as a client with no
    // ordinary dispatch rate.
    const ctx = await arrange();
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    const res = await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    expect(res.status).toBe(200);
    expect(await prisma.monthlyInvoice.count({ where: { clientId: ctx.client.id } })).toBe(0);
  });

  it('records when it left', async () => {
    const ctx = await arrange();
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    const after = await prisma.fdaShipment.findUnique({ where: { id: created.body.id } });
    expect(after.status).toBe('DISPATCHED');
    expect(after.dispatchedAt).not.toBeNull();
  });

  it('refuses to dispatch the same consignment twice', async () => {
    // Otherwise it bills again.
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id);
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);
    const second = await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    expect(second.status).toBe(400);
    const invoice = await invoiceFor(ctx.client.id);
    expect(invoice.lineItems).toHaveLength(1);
  });

  it('does not rewrite a raised charge when the rate later changes', async () => {
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id, '3.00');
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx, { count: 10 }));

    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);
    await prisma.clientService.updateMany({
      where: { clientId: ctx.client.id },
      data: { chargedPrice: '99.00' },
    });

    const invoice = await invoiceFor(ctx.client.id);
    expect(Number(invoice.lineItems[0].totalPrice)).toBe(30);
  });

  it('cannot be dispatched once cancelled', async () => {
    const ctx = await arrange();
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/cancel`);
    const res = await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    expect(res.status).toBe(400);
  });

  it('cannot be cancelled once dispatched, because it has been billed', async () => {
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id);
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);
    const res = await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/cancel`);

    expect(res.status).toBe(400);
  });

  it('is not cancellable by an employee', async () => {
    const ctx = await arrange();
    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    expect(
      (await as(ctx.employeeUser).post(`/api/fda-shipments/${created.body.id}/cancel`)).status
    ).toBe(403);
  });
});

describe('staying out of the warehouse', () => {
  it('moves no stock', async () => {
    // The whole premise: these goods pass through, they are never put away.
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id);
    const before = await prisma.stockLevel.findUnique({ where: { id: ctx.stock.id } });

    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));
    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    const after = await prisma.stockLevel.findUnique({ where: { id: ctx.stock.id } });
    expect(after.currentQuantity).toBe(before.currentQuantity);
    expect(after.reservedQuantity).toBe(before.reservedQuantity);
  });

  it('writes no ledger movement', async () => {
    const ctx = await arrange();
    await giveFdaRate(ctx.client.id);

    const created = await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));
    await as(ctx.admin).post(`/api/fda-shipments/${created.body.id}/dispatch`);

    expect(await prisma.inventoryLedger.count()).toBe(0);
  });

  it('creates no ordinary Shipment row', async () => {
    const ctx = await arrange();

    await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));

    expect(await prisma.shipment.count()).toBe(0);
  });
});

describe('who sees what', () => {
  it('a client sees only their own consignments', async () => {
    const ctx = await arrange();
    const other = await makeWarehouseScenario();
    await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));
    await as(ctx.admin)
      .post('/api/fda-shipments')
      .send(arrival(ctx, { clientId: other.client.id }));

    const res = await as(ctx.clientUser).get('/api/fda-shipments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientId).toBe(ctx.client.id);
  });

  it('staff see everything', async () => {
    const ctx = await arrange();
    const other = await makeWarehouseScenario();
    await as(ctx.admin).post('/api/fda-shipments').send(arrival(ctx));
    await as(ctx.admin)
      .post('/api/fda-shipments')
      .send(arrival(ctx, { clientId: other.client.id }));

    const res = await as(ctx.employeeUser).get('/api/fda-shipments');

    expect(res.body).toHaveLength(2);
  });

  it('404s a client asking for someone else consignment, rather than 403', async () => {
    // 403 would confirm the id exists, which is a probe.
    const ctx = await arrange();
    const other = await makeWarehouseScenario();
    const created = await as(ctx.admin)
      .post('/api/fda-shipments')
      .send(arrival(ctx, { clientId: other.client.id }));

    const res = await as(ctx.clientUser).get(`/api/fda-shipments/${created.body.id}`);

    expect(res.status).toBe(404);
  });
});
