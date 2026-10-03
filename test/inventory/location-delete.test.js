/**
 * Deleting warehouse locations and location classes.
 *
 * Before the dependents check only child locations were looked at, and
 * everything else — stock on the shelf, a shipment picking from it, its
 * movement history — came back as a foreign-key error. Now each is named, and
 * a location's stock history keeps it on the map for good.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeEmployee,
  makeLedgerEntry,
  makeLocation,
  makeLocationClass,
  makeProduct,
  makeStockLevel,
} from '../factories/index.js';

describe('deleting a location', () => {
  it('deletes an empty one, clearing stock rows that have run to zero', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 0 });

    const dependents = await as(admin).get(`/api/warehouse-locations/${location.id}/dependents`);
    expect(dependents.status).toBe(200);
    expect(dependents.body.canDelete).toBe(true);
    expect(dependents.body.removedWith[0]).toMatchObject({ key: 'emptySlots', count: 1 });

    const res = await as(admin).delete(`/api/warehouse-locations/${location.id}`);

    expect(res.status).toBe(204);
    expect(await prisma.warehouseLocation.findUnique({ where: { id: location.id } })).toBeNull();
    expect(await prisma.stockLevel.count({ where: { locationId: location.id } })).toBe(0);
  });

  it('refuses while stock is on the shelf', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 5 });

    const res = await as(admin).delete(`/api/warehouse-locations/${location.id}`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['stock']);
  });

  it('refuses one with child locations', async () => {
    const admin = await makeAdmin();
    const parent = await makeLocation();
    await makeLocation({ parentLocationId: parent.id });

    const res = await as(admin).delete(`/api/warehouse-locations/${parent.id}`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['children']);
  });

  it('keeps one with stock history, for good', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    const location = await makeLocation();
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      quantity: 3,
      toLocationId: location.id,
    });

    const res = await as(admin).delete(`/api/warehouse-locations/${location.id}`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['ledger']);
  });

  it('answers 404 for one that does not exist', async () => {
    const admin = await makeAdmin();
    const res = await as(admin).get(
      '/api/warehouse-locations/00000000-0000-0000-0000-000000000000/dependents',
    );
    expect(res.status).toBe(404);
  });

  it('is admin only', async () => {
    const { user: employeeUser } = await makeEmployee();
    const location = await makeLocation();

    expect((await as(employeeUser).delete(`/api/warehouse-locations/${location.id}`)).status).toBe(403);
    expect(
      (await as(employeeUser).get(`/api/warehouse-locations/${location.id}/dependents`)).status,
    ).toBe(403);
  });
});

describe('deleting a location class', () => {
  it('deletes an unused one', async () => {
    const admin = await makeAdmin();
    const cls = await makeLocationClass();

    const res = await as(admin).delete(`/api/warehouse-location-classes/${cls.id}`);

    expect(res.status).toBe(204);
    expect(await prisma.warehouseLocationClass.findUnique({ where: { id: cls.id } })).toBeNull();
  });

  it('refuses while locations or child classes use it, and counts both', async () => {
    const admin = await makeAdmin();
    const cls = await makeLocationClass();
    await makeLocationClass({ parentClassId: cls.id });
    await makeLocation({ locationClassId: cls.id });

    const dependents = await as(admin).get(`/api/warehouse-location-classes/${cls.id}/dependents`);
    expect(dependents.status).toBe(200);
    const counts = Object.fromEntries(dependents.body.blocking.map((r) => [r.key, r.count]));
    expect(counts).toEqual({ childClasses: 1, locations: 1 });

    const res = await as(admin).delete(`/api/warehouse-location-classes/${cls.id}`);
    expect(res.status).toBe(409);
  });
});
