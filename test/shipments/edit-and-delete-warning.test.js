/**
 * Editing a shipment line, and the warning shown before deleting a shipment.
 *
 * The line update used to write its request body straight to the row: a line
 * could be moved onto another shipment or given another product, and a change
 * of quantity left the reservation at the old figure. Now three fields are
 * editable, two of them only while the line can still change, and the
 * reservation moves with them.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeShipmentRate,
  makeLocation,
  makeStockLevel,
} from '../factories/index.js';

/** A PENDING shipment holding a reservation of `quantity`, as the old flow left them. */
const pendingLine = async (quantity = 4) => {
  const s = await makeWarehouseScenario({ quantity: 20 });
  const shipment = await makeShipment(s.employee.id, s.client.id);
  const item = await makeShipmentItem(shipment.id, s.product.id, s.location.id, { quantity });
  await prisma.stockLevel.update({ where: { id: s.stock.id }, data: { reservedQuantity: quantity } });
  return { ...s, shipment, item };
};

const reservedAt = async (stockId) =>
  (await prisma.stockLevel.findUnique({ where: { id: stockId } })).reservedQuantity;

describe('editing a line', () => {
  it('moves the reservation with a new quantity', async () => {
    const { admin, item, stock } = await pendingLine(4);

    const res = await as(admin).put(`/api/shipment-items/${item.id}`).send({ quantity: 7 });

    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(7);
    expect(await reservedAt(stock.id)).toBe(7);
  });

  it('moves it to another bin, handing the first one back', async () => {
    const { admin, item, stock, product } = await pendingLine(4);
    const other = await makeLocation();
    const otherStock = await makeStockLevel(product.id, other.id, { currentQuantity: 10 });

    const res = await as(admin)
      .put(`/api/shipment-items/${item.id}`)
      .send({ sourceLocationId: other.id });

    expect(res.status).toBe(200);
    expect(await reservedAt(stock.id)).toBe(0);
    expect(await reservedAt(otherStock.id)).toBe(4);
  });

  it('refuses more than the bin can cover, and changes nothing', async () => {
    const { admin, item, stock } = await pendingLine(4);

    const res = await as(admin).put(`/api/shipment-items/${item.id}`).send({ quantity: 500 });

    expect(res.status).toBe(400);
    expect(await reservedAt(stock.id)).toBe(4);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).quantity).toBe(4);
  });

  it('refuses a quantity change once the shipment is dispatched', async () => {
    const { admin, item, shipment } = await pendingLine(4);
    await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'DISPATCHED' } });

    const res = await as(admin).put(`/api/shipment-items/${item.id}`).send({ quantity: 2 });

    expect(res.status).toBe(400);
  });

  it('still takes a tracking id after dispatch', async () => {
    const { admin, item, shipment } = await pendingLine(4);
    await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'DISPATCHED' } });

    const res = await as(admin)
      .put(`/api/shipment-items/${item.id}`)
      .send({ trackingId: 'RM123456789GB' });

    expect(res.status).toBe(200);
  });

  it('ignores fields a line may not change', async () => {
    const { admin, item, client, employee } = await pendingLine(4);
    const elsewhere = await makeShipment(employee.id, client.id);

    await as(admin)
      .put(`/api/shipment-items/${item.id}`)
      .send({ shipmentId: elsewhere.id, returnedQuantity: 4 });

    const after = await prisma.shipmentItem.findUnique({ where: { id: item.id } });
    expect(after.shipmentId).toBe(item.shipmentId);
    expect(after.returnedQuantity ?? 0).toBe(0);
  });
});

describe('the warning before deleting a shipment', () => {
  it('lists what goes back and what comes off the invoice', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    await makeShipmentRate(s.client.id, '2.00');
    const created = await as(s.admin)
      .post('/api/shipments')
      .send({
        shipmentItems: [{ productId: s.product.id, sourceLocationId: s.location.id, quantity: 10 }],
      });
    expect(created.status).toBe(201);

    const res = await as(s.admin).get(`/api/shipments/${created.body.id}/dependents`);

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(true);
    const removed = Object.fromEntries(res.body.removedWith.map((r) => [r.key, r.count]));
    expect(removed).toMatchObject({ items: 1, units: 10, charges: 1 });
  });

  it('is open to exactly who may delete', async () => {
    const s = await makeWarehouseScenario({ permissions: ['shipments:read'] });
    const shipment = await makeShipment(s.employee.id, s.client.id);

    expect(
      (await as(s.employeeUser).get(`/api/shipments/${shipment.id}/dependents`)).status,
    ).toBe(403);
  });
});
