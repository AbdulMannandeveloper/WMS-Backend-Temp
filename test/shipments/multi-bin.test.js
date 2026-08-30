/**
 * Drawing one product from several bins.
 *
 * Stock lives per location, so an order larger than any single bin holds has to
 * be split. The schema already models this — ShipmentItem is keyed on
 * (shipment, product, location) with its own quantity — but nothing had ever
 * exercised it, and the create dialog only ever let an operator choose one
 * location per product, so the split path was unreachable from the UI.
 *
 * These hold the server side of it: the reservation has to come out of each bin
 * separately, and the dispatch charge has to count every unit exactly once.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeLocation,
  makeStockLevel,
  makeShipmentRate,
} from '../factories/index.js';

/** One product in two bins: 10 available in the first, 15 in the second. */
const arrangeTwoBins = async () => {
  const scenario = await makeWarehouseScenario({ quantity: 10 });
  const second = await makeLocation();
  const secondStock = await makeStockLevel(scenario.product.id, second.id, {
    currentQuantity: 15,
  });
  return { ...scenario, secondLocation: second, secondStock };
};

const createShipment = (actor, scenario, items) =>
  as(actor)
    .post('/api/shipments')
    .send({
      clientId: scenario.client.id,
      employeeId: scenario.employee.id,
      shipmentType: 'Standard',
      packagingType: 'Box',
      courierName: 'Evri',
      shipmentItems: items,
    });

describe('a shipment drawn from two bins', () => {
  it('creates one item row per bin', async () => {
    const scenario = await arrangeTwoBins();

    const res = await createShipment(scenario.admin, scenario, [
      { productId: scenario.product.id, sourceLocationId: scenario.location.id, quantity: 8 },
      { productId: scenario.product.id, sourceLocationId: scenario.secondLocation.id, quantity: 12 },
    ]);

    expect(res.status).toBe(201);
    const items = await prisma.shipmentItem.findMany({
      where: { shipmentId: res.body.id },
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.quantity).sort((a, b) => a - b)).toEqual([8, 12]);
  });

  it('reserves from each bin separately', async () => {
    // The whole reason the split exists: 20 units when neither bin holds 20.
    const scenario = await arrangeTwoBins();

    await createShipment(scenario.admin, scenario, [
      { productId: scenario.product.id, sourceLocationId: scenario.location.id, quantity: 8 },
      { productId: scenario.product.id, sourceLocationId: scenario.secondLocation.id, quantity: 12 },
    ]);

    const first = await prisma.stockLevel.findUnique({ where: { id: scenario.stock.id } });
    const second = await prisma.stockLevel.findUnique({ where: { id: scenario.secondStock.id } });

    expect(first.reservedQuantity).toBe(8);
    expect(second.reservedQuantity).toBe(12);
  });

  it('refuses the whole shipment if one bin cannot cover its share', async () => {
    // Atomic: a partial reservation would leave stock locked against a shipment
    // that was never created.
    const scenario = await arrangeTwoBins();

    const res = await createShipment(scenario.admin, scenario, [
      { productId: scenario.product.id, sourceLocationId: scenario.location.id, quantity: 8 },
      { productId: scenario.product.id, sourceLocationId: scenario.secondLocation.id, quantity: 99 },
    ]);

    expect(res.status).toBe(400);
    const first = await prisma.stockLevel.findUnique({ where: { id: scenario.stock.id } });
    expect(first.reservedQuantity).toBe(0);
    expect(await prisma.shipment.count()).toBe(0);
  });

  it('bills every unit once, across both bins', async () => {
    // 8 + 12 = 20 units at 2.00, not two charges and not one bin's worth.
    const scenario = await arrangeTwoBins();
    await makeShipmentRate(scenario.client.id, '2.00');

    const created = await createShipment(scenario.admin, scenario, [
      { productId: scenario.product.id, sourceLocationId: scenario.location.id, quantity: 8 },
      { productId: scenario.product.id, sourceLocationId: scenario.secondLocation.id, quantity: 12 },
    ]);

    // Pick both lines, then send it.
    const items = await prisma.shipmentItem.findMany({
      where: { shipmentId: created.body.id },
    });
    for (const item of items) {
      await as(scenario.admin).put(`/api/shipment-items/${item.id}/pick`);
    }
    await as(scenario.admin).post(`/api/shipments/${created.body.id}/ready`);
    await as(scenario.admin).post(`/api/shipments/${created.body.id}/dispatch`);

    const invoice = await prisma.monthlyInvoice.findFirst({
      where: { clientId: scenario.client.id },
      include: { lineItems: true },
    });
    const charges = invoice.lineItems.filter((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(charges).toHaveLength(1);
    expect(Number(charges[0].quantity)).toBe(20);
    expect(Number(charges[0].totalPrice)).toBe(40);
  });

  it('takes the stock out of both bins on dispatch', async () => {
    const scenario = await arrangeTwoBins();

    const created = await createShipment(scenario.admin, scenario, [
      { productId: scenario.product.id, sourceLocationId: scenario.location.id, quantity: 8 },
      { productId: scenario.product.id, sourceLocationId: scenario.secondLocation.id, quantity: 12 },
    ]);

    const items = await prisma.shipmentItem.findMany({
      where: { shipmentId: created.body.id },
    });
    for (const item of items) {
      await as(scenario.admin).put(`/api/shipment-items/${item.id}/pick`);
    }
    await as(scenario.admin).post(`/api/shipments/${created.body.id}/ready`);
    await as(scenario.admin).post(`/api/shipments/${created.body.id}/dispatch`);

    const first = await prisma.stockLevel.findUnique({ where: { id: scenario.stock.id } });
    const second = await prisma.stockLevel.findUnique({ where: { id: scenario.secondStock.id } });

    expect(first.currentQuantity).toBe(2); // 10 - 8
    expect(second.currentQuantity).toBe(3); // 15 - 12
  });

  it('writes a ledger movement out of each bin', async () => {
    // The audit trail has to say which shelf the goods left, not just how many.
    const scenario = await arrangeTwoBins();

    const created = await createShipment(scenario.admin, scenario, [
      { productId: scenario.product.id, sourceLocationId: scenario.location.id, quantity: 8 },
      { productId: scenario.product.id, sourceLocationId: scenario.secondLocation.id, quantity: 12 },
    ]);

    const items = await prisma.shipmentItem.findMany({
      where: { shipmentId: created.body.id },
    });
    for (const item of items) {
      await as(scenario.admin).put(`/api/shipment-items/${item.id}/pick`);
    }
    await as(scenario.admin).post(`/api/shipments/${created.body.id}/ready`);
    await as(scenario.admin).post(`/api/shipments/${created.body.id}/dispatch`);

    const ledger = await prisma.inventoryLedger.findMany({
      where: { referenceId: created.body.id, movementType: 'CHECKOUT' },
    });

    expect(ledger).toHaveLength(2);
    expect(ledger.map((l) => l.fromLocationId).sort()).toEqual(
      [scenario.location.id, scenario.secondLocation.id].sort()
    );
  });
});
