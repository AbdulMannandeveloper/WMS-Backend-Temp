/**
 * Returning goods after dispatch.
 *
 * An admin opens a dispatched shipment, picks a line, and sends some or all of
 * it back to the shelf. Stock goes up; the invoice does not move.
 *
 * That last part is the whole point and is asserted several ways below. The
 * dispatch happened and was charged for. What happens to the goods afterwards
 * is a commercial conversation — a credit note, a replacement, an argument —
 * and silently amending an invoice from a warehouse action is not a decision
 * this system should be making on someone's behalf.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeShipmentRate,
} from '../factories/index.js';

/** A dispatched shipment of 10 units, billed at 2.00 an item. */
const arrangeDispatched = async ({ units = 10, rate = '2.00' } = {}) => {
  const scenario = await makeWarehouseScenario({ quantity: 100 });
  const { admin, employee, client, product, location, stock } = scenario;

  if (rate !== null) await makeShipmentRate(client.id, rate);

  const shipment = await makeShipment(employee.id, client.id, {
    status: 'READY_FOR_DISPATCH',
  });
  const item = await makeShipmentItem(shipment.id, product.id, location.id, {
    quantity: units,
    status: 'PICKED',
  });
  await prisma.stockLevel.update({
    where: { id: stock.id },
    data: { reservedQuantity: units },
  });

  await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

  return { ...scenario, shipment, item };
};

const stockAt = (id) => prisma.stockLevel.findUnique({ where: { id } });

const invoiceFor = (clientId) =>
  prisma.monthlyInvoice.findFirst({
    where: { clientId },
    include: { lineItems: true },
  });

describe('returning stock to the shelf', () => {
  it('puts the quantity back in the bin it was picked from', async () => {
    const ctx = await arrangeDispatched({ units: 10 });
    const before = await stockAt(ctx.stock.id);

    const res = await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    const after = await stockAt(ctx.stock.id);
    expect(after.currentQuantity).toBe(before.currentQuantity + 3);
  });

  it('records how much of the line has come back', async () => {
    const ctx = await arrangeDispatched({ units: 10 });

    await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 3 });

    const after = await prisma.shipmentItem.findUnique({ where: { id: ctx.item.id } });
    expect(after.returnedQuantity).toBe(3);
    expect(after.quantity).toBe(10); // what went out is unchanged
  });

  it('allows the whole line to come back', async () => {
    const ctx = await arrangeDispatched({ units: 10 });
    const before = await stockAt(ctx.stock.id);

    const res = await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 10 });

    expect(res.status).toBe(200);
    const after = await stockAt(ctx.stock.id);
    expect(after.currentQuantity).toBe(before.currentQuantity + 10);
  });

  it('accumulates across several partial returns', async () => {
    const ctx = await arrangeDispatched({ units: 10 });

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 4 });
    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 3 });

    const after = await prisma.shipmentItem.findUnique({ where: { id: ctx.item.id } });
    expect(after.returnedQuantity).toBe(7);
  });

  it('logs a RETURN movement, not a supplier check-in', async () => {
    // Folding these together would make every goods-in report wrong.
    const ctx = await arrangeDispatched();

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 5 });

    const ledger = await prisma.inventoryLedger.findMany({
      where: { movementType: 'RETURN' },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].quantity).toBe(5);
    expect(ledger[0].toLocationId).toBe(ctx.location.id);
  });

  it('does not count a return as stock arriving today', async () => {
    // arrivedTodayQuantity drives the goods-in view; a return is not a delivery.
    const ctx = await arrangeDispatched();
    const before = await stockAt(ctx.stock.id);

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 5 });

    const after = await stockAt(ctx.stock.id);
    expect(after.arrivedTodayQuantity).toBe(before.arrivedTodayQuantity);
  });
});

describe('the invoice is not touched', () => {
  it('the total is identical after a return', async () => {
    // The guarantee, stated plainly. 10 items at 2.00 = 20.00, and it stays
    // 20.00 however much comes back.
    const ctx = await arrangeDispatched({ units: 10, rate: '2.00' });
    const before = await invoiceFor(ctx.client.id);
    expect(Number(before.totalAmount)).toBe(20);

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 6 });

    const after = await invoiceFor(ctx.client.id);
    expect(Number(after.totalAmount)).toBe(20);
  });

  it('no line is added, amended or reversed', async () => {
    const ctx = await arrangeDispatched({ units: 10, rate: '2.00' });
    const before = await invoiceFor(ctx.client.id);

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 6 });

    const after = await invoiceFor(ctx.client.id);
    expect(after.lineItems).toHaveLength(before.lineItems.length);
    expect(after.lineItems.map((l) => l.id).sort()).toEqual(
      before.lineItems.map((l) => l.id).sort()
    );
  });

  it('the shipment charge still shows the quantity that was dispatched', async () => {
    // Not reduced to what stayed out — the charge records what happened.
    const ctx = await arrangeDispatched({ units: 10, rate: '2.00' });

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 10 });

    const invoice = await invoiceFor(ctx.client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');
    expect(Number(charge.quantity)).toBe(10);
    expect(Number(charge.totalPrice)).toBe(20);
  });

  it('returning everything still leaves the invoice standing', async () => {
    const ctx = await arrangeDispatched({ units: 10, rate: '2.00' });

    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 10 });

    const invoice = await invoiceFor(ctx.client.id);
    expect(Number(invoice.totalAmount)).toBe(20);
    expect(invoice.status).toBe('DRAFT');
  });
});

describe('what is refused', () => {
  it('more than the line held', async () => {
    const ctx = await arrangeDispatched({ units: 10 });

    const res = await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 11 });

    expect(res.status).toBe(400);
    const after = await prisma.shipmentItem.findUnique({ where: { id: ctx.item.id } });
    expect(after.returnedQuantity).toBe(0);
  });

  it('the same units twice', async () => {
    // Without the running total, ten units could be returned ten times.
    const ctx = await arrangeDispatched({ units: 10 });
    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 10 });

    const res = await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been returned/i);
  });

  it('a partial return that would overshoot what is still out', async () => {
    const ctx = await arrangeDispatched({ units: 10 });
    await as(ctx.admin).post(`/api/shipment-items/${ctx.item.id}/return`).send({ quantity: 7 });

    const res = await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 4 });

    expect(res.status).toBe(400);
    const after = await prisma.shipmentItem.findUnique({ where: { id: ctx.item.id } });
    expect(after.returnedQuantity).toBe(7);
  });

  it('zero, negative and fractional quantities', async () => {
    const ctx = await arrangeDispatched();

    for (const quantity of [0, -3, 2.5]) {
      const res = await as(ctx.admin)
        .post(`/api/shipment-items/${ctx.item.id}/return`)
        .send({ quantity });
      expect(res.status).toBe(400);
    }
  });

  it('a shipment that has not been dispatched', async () => {
    // Unpick and cancel already put reserved stock back; a second path doing the
    // same job is how the two end up disagreeing.
    const scenario = await makeWarehouseScenario({ quantity: 100 });
    const shipment = await makeShipment(scenario.employee.id, scenario.client.id, {
      status: 'PENDING',
    });
    const item = await makeShipmentItem(
      shipment.id,
      scenario.product.id,
      scenario.location.id,
      { quantity: 5 }
    );

    const res = await as(scenario.admin)
      .post(`/api/shipment-items/${item.id}/return`)
      .send({ quantity: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dispatched/i);
  });

  it('an employee, because it is a commercial decision', async () => {
    const ctx = await arrangeDispatched();

    const res = await as(ctx.employeeUser)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 2 });

    expect(res.status).toBe(403);
  });

  it('a client', async () => {
    const ctx = await arrangeDispatched();

    const res = await as(ctx.clientUser)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 2 });

    expect(res.status).toBe(403);
  });

  it('an item that does not exist', async () => {
    const ctx = await arrangeDispatched();

    const res = await as(ctx.admin)
      .post('/api/shipment-items/00000000-0000-0000-0000-000000000000/return')
      .send({ quantity: 1 });

    expect(res.status).toBe(404);
  });
});

describe('the audit trail', () => {
  it('records the return, and that the invoice was left alone', async () => {
    const ctx = await arrangeDispatched({ units: 10 });

    await as(ctx.admin)
      .post(`/api/shipment-items/${ctx.item.id}/return`)
      .send({ quantity: 4, reason: 'Damaged in transit' });

    const log = await prisma.auditLog.findFirst({
      where: { action: 'SHIPMENT_ITEM_RETURNED' },
    });
    expect(log).not.toBeNull();
    expect(log.details).toContain('Damaged in transit');
    expect(log.details).toContain('invoiceChanged');
  });
});
