/**
 * Deactivating services, warehouse locations and location classes — the way
 * out for one still in use, which can no longer be deleted.
 *
 * What must hold:
 *   - Services: an admin can switch one off and on; a built-in one stays on.
 *     Off, it cannot be agreed with a client, attached to a shipment or
 *     charged — but it stays on what already carries it.
 *   - Locations: only an empty one with no active location inside it can be
 *     switched off. Off, deliveries, moves and restocked returns cannot go
 *     into it and no new location can go inside it. It comes back on only
 *     while its parent and class are on.
 *   - Classes: off only with no active location of that class; off, no new
 *     location takes it.
 *   - Admin-only, like delete — and an ordinary edit, which employees may
 *     make, cannot switch anything off.
 *   - A delete refused for history now points at deactivating instead.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeClientService,
  makeEmployee,
  makeLocation,
  makeLocationClass,
  makeService,
  makeShipment,
  makeStockLevel,
  makeWarehouseScenario,
} from '../factories/index.js';

const deactivate = (user, path) => as(user).patch(`${path}/active`).send({ isActive: false });
const reactivate = (user, path) => as(user).patch(`${path}/active`).send({ isActive: true });

describe('services', () => {
  it('can be switched off and back on by an admin', async () => {
    const admin = await makeAdmin();
    const service = await makeService();

    const off = await deactivate(admin, `/api/services/${service.id}`);
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);

    expect((await reactivate(admin, `/api/services/${service.id}`)).body.isActive).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'DEACTIVATE_SERVICE' } })).toBe(1);
  });

  it('stay on when built in', async () => {
    const admin = await makeAdmin();
    const service = await makeService({ code: 'SHIPMENT_DISPATCH' });

    const res = await deactivate(admin, `/api/services/${service.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/built in/);
  });

  it('when off, cannot be agreed, attached or charged', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const { employee } = await makeEmployee();
    const service = await makeService();
    const rate = await makeClientService(client.id, service.id);
    const shipment = await makeShipment(employee.id, client.id);
    await deactivate(admin, `/api/services/${service.id}`);

    const { client: other } = await makeClient();
    const agreed = await as(admin)
      .post('/api/client-services')
      .send({ clientId: other.id, serviceId: service.id, chargedPrice: 4 });
    const attached = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });
    const charged = await as(admin)
      .post('/api/monthly-invoices/charge-service')
      .send({ clientId: client.id, clientServiceId: rate.id, quantity: 1 });

    for (const res of [agreed, attached, charged]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toMatch(/deactivated/);
    }
  });

  it('point at deactivating when a delete is refused', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const { employee } = await makeEmployee();
    const service = await makeService();
    await makeClientService(client.id, service.id);
    const shipment = await makeShipment(employee.id, client.id);
    await as(admin).post(`/api/shipments/${shipment.id}/services`).send({ serviceId: service.id, quantity: 1 });

    const res = await as(admin).delete(`/api/services/${service.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivate it instead/);
  });
});

describe('locations', () => {
  it('can be switched off when empty, and back on', async () => {
    const admin = await makeAdmin();
    const location = await makeLocation();

    const off = await deactivate(admin, `/api/warehouse-locations/${location.id}`);
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect((await reactivate(admin, `/api/warehouse-locations/${location.id}`)).body.isActive).toBe(true);
  });

  it('cannot be switched off while holding stock', async () => {
    const { admin, location } = await makeWarehouseScenario();

    const res = await deactivate(admin, `/api/warehouse-locations/${location.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still holds stock/);
  });

  it('cannot be switched off with an active location inside', async () => {
    const admin = await makeAdmin();
    const parent = await makeLocation();
    await makeLocation({ parentLocationId: parent.id });

    expect((await deactivate(admin, `/api/warehouse-locations/${parent.id}`)).status).toBe(409);
  });

  it('when off, take no delivery, move or restocked return', async () => {
    const { admin, client, product, location: source } = await makeWarehouseScenario();
    const retired = await makeLocation();
    await deactivate(admin, `/api/warehouse-locations/${retired.id}`);

    const checkIn = await as(admin)
      .post('/api/inventory-ledgers')
      .send({ productId: product.id, movementType: 'CHECKIN', quantity: 1, toLocationId: retired.id });
    const move = await as(admin).post('/api/inventory-ledgers').send({
      productId: product.id,
      movementType: 'INTERNAL_MOVE',
      quantity: 1,
      fromLocationId: source.id,
      toLocationId: retired.id,
    });
    const productReturn = await prisma.productReturn.create({
      data: { reference: 'RET-DEACT-1', clientId: client.id, productId: product.id, quantity: 1 },
    });
    const restock = await as(admin)
      .post(`/api/returns/${productReturn.id}/restock`)
      .send({ locationId: retired.id });

    for (const res of [checkIn, move, restock]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toMatch(/deactivated/);
    }
    expect(await prisma.stockLevel.count({ where: { locationId: retired.id } })).toBe(0);
  });

  it('when off, take no new location inside', async () => {
    const admin = await makeAdmin();
    const locationClass = await makeLocationClass();
    const parent = await makeLocation({ locationClassId: locationClass.id });
    await deactivate(admin, `/api/warehouse-locations/${parent.id}`);

    const res = await as(admin)
      .post('/api/warehouse-locations')
      .send({ locationName: 'BIN-NEW', locationClassId: locationClass.id, parentLocationId: parent.id });

    expect(res.status).toBe(409);
  });

  it('come back on only while their parent is on', async () => {
    const admin = await makeAdmin();
    const parent = await makeLocation();
    const child = await makeLocation({ parentLocationId: parent.id });
    await deactivate(admin, `/api/warehouse-locations/${child.id}`);
    await deactivate(admin, `/api/warehouse-locations/${parent.id}`);

    const res = await reactivate(admin, `/api/warehouse-locations/${child.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Reactivate that first/);
  });

  it('point at deactivating when a delete is refused for history', async () => {
    const { admin, product, location } = await makeWarehouseScenario();
    const other = await makeLocation();
    await makeStockLevel(product.id, other.id, { currentQuantity: 0 });
    await as(admin).post('/api/inventory-ledgers').send({
      productId: product.id,
      movementType: 'INTERNAL_MOVE',
      quantity: 1,
      fromLocationId: location.id,
      toLocationId: other.id,
    });

    const res = await as(admin).delete(`/api/warehouse-locations/${location.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivate it instead/);
  });
});

describe('location classes', () => {
  it('cannot be switched off while an active location has them', async () => {
    const admin = await makeAdmin();
    const locationClass = await makeLocationClass();
    await makeLocation({ locationClassId: locationClass.id });

    expect((await deactivate(admin, `/api/warehouse-location-classes/${locationClass.id}`)).status).toBe(409);
  });

  it('when off, are taken by no new location', async () => {
    const admin = await makeAdmin();
    const locationClass = await makeLocationClass();
    expect((await deactivate(admin, `/api/warehouse-location-classes/${locationClass.id}`)).status).toBe(200);

    const res = await as(admin)
      .post('/api/warehouse-locations')
      .send({ locationName: 'BIN-NEW', locationClassId: locationClass.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivated/);
  });
});

describe('who may switch things off', () => {
  it('is admins only', async () => {
    const { user } = await makeEmployee();
    const service = await makeService();
    const location = await makeLocation();
    const locationClass = await makeLocationClass();

    expect((await deactivate(user, `/api/services/${service.id}`)).status).toBe(403);
    expect((await deactivate(user, `/api/warehouse-locations/${location.id}`)).status).toBe(403);
    expect((await deactivate(user, `/api/warehouse-location-classes/${locationClass.id}`)).status).toBe(403);
  });

  it('not through an ordinary edit, which employees may make', async () => {
    const { employeeUser } = await makeWarehouseScenario();
    const location = await makeLocation();
    const locationClass = await makeLocationClass();

    await as(employeeUser)
      .put(`/api/warehouse-locations/${location.id}`)
      .send({ locationName: 'Renamed', isActive: false });
    await as(employeeUser)
      .put(`/api/warehouse-location-classes/${locationClass.id}`)
      .send({ name: 'Renamed class', isActive: false });

    const after = await prisma.warehouseLocation.findUnique({ where: { id: location.id } });
    expect(after.locationName).toBe('Renamed');
    expect(after.isActive).toBe(true);
    expect((await prisma.warehouseLocationClass.findUnique({ where: { id: locationClass.id } })).isActive).toBe(
      true,
    );
  });
});
