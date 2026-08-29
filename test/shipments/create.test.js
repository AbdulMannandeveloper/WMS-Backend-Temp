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
import { makeWarehouseScenario, makeProduct, makeStockLevel } from '../factories/index.js';

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
