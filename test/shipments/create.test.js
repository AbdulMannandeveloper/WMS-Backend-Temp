/**
 * Creating a shipment with its items in one request — the only way the UI makes
 * a shipment.
 *
 * This was broken by a circular import: logic/shipment.logic.js requires
 * logic/shipment_item.logic.js, which required it straight back. Node hands
 * whichever module loads second a partially-initialised exports object, and
 * because these files reassign module.exports rather than mutating it, that
 * reference stayed empty. `shipmentLogic.getShipmentByField` was therefore
 * undefined inside the item logic, and every create-with-items request died on
 * "shipmentLogic.getShipmentByField is not a function".
 *
 * Chunk 1.2 broke the cycle by reading through the repository instead. These
 * tests exist so it cannot come back — a cycle would make them fail loudly
 * rather than silently at runtime.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeProduct,
  makeStockLevel,
  makeService,
  makeClientService,
} from '../factories/index.js';

describe('creating a shipment', () => {
  it('creates the shipment and its items in one request', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario({ quantity: 100 });

    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 10 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.shipmentItems).toHaveLength(1);
    expect(res.body.status).toBe('PENDING');
  });

  it('reserves the stock it commits to', async () => {
    const { admin, employee, client, product, location, stock } =
      await makeWarehouseScenario({ quantity: 100 });

    await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 10 },
        ],
      });

    const after = await prisma.stockLevel.findUnique({ where: { id: stock.id } });
    expect(after.currentQuantity).toBe(100); // nothing has physically moved yet
    expect(after.reservedQuantity).toBe(10);
  });

  it('handles several items across different products', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario({ quantity: 100 });
    const second = await makeProduct(client.id, { productName: 'Red Widget' });
    await makeStockLevel(second.id, location.id, { currentQuantity: 50 });

    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 10 },
          { productId: second.id, sourceLocationId: location.id, quantity: 5 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.shipmentItems).toHaveLength(2);
  });

  it('refuses to reserve more than the bin holds', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario({ quantity: 3 });

    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 10 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient/i);
  });

  it('leaves nothing behind when one line cannot be reserved', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario({ quantity: 100 });
    const scarce = await makeProduct(client.id, { productName: 'Scarce' });
    await makeStockLevel(scarce.id, location.id, { currentQuantity: 1 });

    // First line is fine; the second asks for more than the bin holds.
    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 10 },
          { productId: scarce.id, sourceLocationId: location.id, quantity: 99 },
        ],
      });

    expect(res.status).toBe(400);

    // Before chunk 1.3 this left orphanShipments=1, orphanItems=1 and 10 units
    // reserved forever against a shipment the caller believed was never created.
    await expect(prisma.shipment.count()).resolves.toBe(0);
    await expect(prisma.shipmentItem.count()).resolves.toBe(0);

    const stock = await prisma.stockLevel.findFirst({
      where: { productId: product.id },
    });
    expect(stock.reservedQuantity).toBe(0);
  });

  it('creates services alongside items, or neither', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario();
    const service = await makeService({ description: 'Fragile wrapping' });
    await makeClientService(client.id, service.id, { chargedPrice: '4.50' });

    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 1 },
        ],
        shipmentServices: [{ serviceId: service.id, quantity: 2 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.shipmentServices).toHaveLength(1);
    // Priced from the client's agreed rate and frozen onto the mapping.
    expect(Number(res.body.shipmentServices[0].appliedUnitPrice)).toBe(4.5);
  });

  it('refuses a service the client has no agreed rate for, and creates nothing', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario();
    const service = await makeService({ description: 'Unpriced service' });
    // Deliberately no ClientService row for this client.

    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 1 },
        ],
        shipmentServices: [{ serviceId: service.id, quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not set up for this client/i);
    await expect(prisma.shipment.count()).resolves.toBe(0);
    await expect(prisma.shipmentItem.count()).resolves.toBe(0);
  });

  it('always starts at PENDING, whatever status the caller asks for', async () => {
    const { admin, employee, client, product, location } =
      await makeWarehouseScenario();

    const res = await as(admin)
      .post('/api/shipments')
      .send({
        employeeId: employee.id,
        clientId: client.id,
        shipmentType: 'Standard',
        packagingType: 'Box',
        courierName: 'Evri',
        status: 'DISPATCHED',
        shipmentItems: [
          { productId: product.id, sourceLocationId: location.id, quantity: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
  });
});
