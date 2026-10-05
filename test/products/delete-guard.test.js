/**
 * What has to be true before a product row is destroyed.
 *
 * The line is **whether anything has left**, not whether anything has happened.
 * A product that was registered, filled and shuffled between bins is a mistake
 * made inside this building and can be taken back out. One that has been
 * dispatched is on a client's invoice, and its ledger rows are the only record
 * of what they were charged for. (In testing mode that last refusal is lifted.)
 *
 * Deleting takes the stock rows and the movement history with it, which is the
 * only place in the system where units leave the record without a movement of
 * their own — so the counts come back on the response, and the tests check
 * that nothing is left behind.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeProduct,
  makeLocation,
  makeStockLevel,
  makeShipment,
  makeShipmentItem,
  makeLedgerEntry,
} from '../factories/index.js';
// TESTING-ONLY start
import { enableTestingDeletes } from '../helpers/testingMode.js';
// TESTING-ONLY end

describe('deleting a product', () => {
  it('deletes one that has never been used', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Never Used' });

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toBeNull();
  });

  it('deletes one that was filled but never shipped, and clears up after it', async () => {
    // The case this rule exists for: registered, stocked, and then found to be
    // wrong. Nothing left the building and nobody was billed, so there is no
    // history worth keeping.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Blue Tape' });
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 40 });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      quantity: 40,
      toLocationId: location.id,
    });

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.unitsRemoved).toBe(40);
    expect(res.body.locationsCleared).toBe(1);
    expect(res.body.movementsRemoved).toBe(1);

    expect(await prisma.product.findUnique({ where: { id: product.id } })).toBeNull();
    expect(await prisma.stockLevel.count({ where: { productId: product.id } })).toBe(0);
    expect(await prisma.inventoryLedger.count({ where: { productId: product.id } })).toBe(0);
  });

  it('is not blocked by an internal move or a write-off', async () => {
    // Neither of these is stock leaving on somebody's order.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Shuffled' });
    const from = await makeLocation();
    const to = await makeLocation();
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'INTERNAL_MOVE',
      quantity: 5,
      fromLocationId: from.id,
      toLocationId: to.id,
    });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'ADJUSTMENT',
      quantity: 2,
      fromLocationId: to.id,
      notes: 'damaged',
    });

    expect((await as(admin).delete(`/api/products/${product.id}`)).status).toBe(200);
  });

  it('refuses one that has been dispatched', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Already Gone' });
    const location = await makeLocation();
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKOUT',
      quantity: 3,
      fromLocationId: location.id,
      referenceId: 'SHP-000123',
    });

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Already Gone/);
    expect(res.body.error).toMatch(/[Dd]eactivate/);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['dispatched']);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it('refuses one whose goods came back, too', async () => {
    // A RETURN only exists after a dispatch, so this is the same story with the
    // CHECKOUT row since removed.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Came Back' });
    const location = await makeLocation();
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'RETURN',
      quantity: 1,
      toLocationId: location.id,
    });

    expect((await as(admin).delete(`/api/products/${product.id}`)).status).toBe(409);
  });

  // TESTING-ONLY start
  it('in testing mode, deletes one that was dispatched once its shipment is gone, history and all', async () => {
    // A deleted dispatched shipment leaves its CHECKOUT and the RETURN that
    // reversed it behind. Nothing names the product any more, so they go with it.
    await enableTestingDeletes();
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Already Gone' });
    const location = await makeLocation();
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKOUT',
      quantity: 3,
      fromLocationId: location.id,
      referenceId: 'SHP-000123',
    });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'RETURN',
      quantity: 3,
      toLocationId: location.id,
      referenceId: 'SHP-000123',
    });

    const before = await as(admin).get(`/api/products/${product.id}/dependents`);
    expect(before.body.canDelete).toBe(true);
    expect(before.body.removedWith).toEqual([expect.objectContaining({ key: 'movements', count: 2 })]);

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.movementsRemoved).toBe(2);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toBeNull();
    expect(await prisma.inventoryLedger.count({ where: { productId: product.id } })).toBe(0);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'DELETE_PRODUCT' } });
    expect(JSON.parse(entry.details)).toMatchObject({ productId: product.id, testingMode: true });
  });

  it("in testing mode, leaves other products' movements alone", async () => {
    await enableTestingDeletes();
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Test Stock' });
    const other = await makeProduct(client.id, { productName: 'Real Stock' });
    const location = await makeLocation();
    await makeLedgerEntry(product.id, admin.id, { movementType: 'CHECKOUT', quantity: 1, fromLocationId: location.id });
    await makeLedgerEntry(other.id, admin.id, { movementType: 'CHECKOUT', quantity: 1, fromLocationId: location.id });

    expect((await as(admin).delete(`/api/products/${product.id}`)).status).toBe(200);

    expect(await prisma.inventoryLedger.count({ where: { productId: other.id } })).toBe(1);
  });
  // TESTING-ONLY end

  it('refuses while the product sits on a shipment', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'On A Pallet' });
    const location = await makeLocation();
    const shipment = await makeShipment(employee.id, client.id);
    await makeShipmentItem(shipment.id, product.id, location.id);

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/On A Pallet/);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['shipments']);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it('destroys nothing on a refusal', async () => {
    // The delete removes ledger rows before it removes the product. If that
    // ever ran ahead of the guards, a refused delete would still have erased
    // the history of a product that is left standing — a worse outcome than
    // either deleting it or refusing, and a silent one.
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Refused' });
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 6 });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      quantity: 6,
      toLocationId: location.id,
    });

    const shipment = await makeShipment(employee.id, client.id);
    await makeShipmentItem(shipment.id, product.id, location.id);

    expect((await as(admin).delete(`/api/products/${product.id}`)).status).toBe(409);

    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
    expect(await prisma.inventoryLedger.count({ where: { productId: product.id } })).toBe(1);
    expect(await prisma.stockLevel.count({ where: { productId: product.id } })).toBe(1);
  });

  it('says what would be refused, and what would go, before anything is pressed', async () => {
    const admin = await makeAdmin();
    const { employee } = await makeEmployee();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 7 });
    const shipment = await makeShipment(employee.id, client.id);
    await makeShipmentItem(shipment.id, product.id, location.id);

    const res = await as(admin).get(`/api/products/${product.id}/dependents`);

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(false);
    expect(res.body.blocking.map((r) => r.key)).toEqual(['shipments']);
    expect(res.body.removedWith).toEqual([
      expect.objectContaining({ key: 'units', count: 7 }),
    ]);
  });

  it('answers 404 for a product that is not there', async () => {
    const admin = await makeAdmin();

    const res = await as(admin).delete(
      '/api/products/00000000-0000-0000-0000-000000000000',
    );

    expect(res.status).toBe(404);
  });

  it('is closed to employees', async () => {
    // Registering, editing and deactivating stay on the floor. Destroying the
    // row does not — it is permanent, and it belongs with whoever also cancels
    // shipments.
    const { user: employeeUser } = await makeEmployee();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);

    const res = await as(employeeUser).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(403);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });
});
