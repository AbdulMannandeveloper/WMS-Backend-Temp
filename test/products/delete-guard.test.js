/**
 * What has to be true before a product row is destroyed.
 *
 * The line is **whether anything has left**, not whether anything has happened.
 * A product that was registered, filled and shuffled between bins is a mistake
 * made inside this building and can be taken back out. One that has been
 * dispatched is on a client's invoice, and its ledger rows are the only record
 * of what they were charged for.
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
    expect(res.body.error).toMatch(/dispatched/i);
    expect(res.body.error).toMatch(/[Dd]eactivate/);
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
    expect(res.body.error).toMatch(/shipment/i);
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
