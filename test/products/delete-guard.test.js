/**
 * What has to be true before a product row is destroyed.
 *
 * `deleteProduct` had no guard at all: it called the repository straight
 * through. Two schema facts made that worse than it looks.
 *
 * `StockLevel.product` is `onDelete: Cascade`, so deleting a product with units
 * on the shelf silently deleted the rows saying where they were. The stock did
 * not stop existing — the record of it did, and the discrepancy only surfaces at
 * the next count.
 *
 * `InventoryLedger.product` and `ShipmentItem.product` are `onDelete: Restrict`,
 * so those cases already failed — but as a raw foreign-key error the controller
 * returned as a 500, which tells an operator nothing and looks like an outage.
 *
 * So: refuse, by name, with what to do instead.
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

  it('refuses while stock is on the shelf, and says how much', async () => {
    // The dangerous case: without this the cascade quietly takes the stock
    // rows with it and the units become invisible rather than gone.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Blue Tape' });
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 12 });

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Blue Tape/);
    expect(res.body.error).toMatch(/12 units/);

    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
    // The point of the guard: the stock row is still there too.
    expect(await prisma.stockLevel.count({ where: { productId: product.id } })).toBe(1);
  });

  it('refuses when the product has ledger history', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { productName: 'Moved Once' });
    const location = await makeLocation();
    // Zero on hand — it went in and came out again — so only the history stands
    // between this product and deletion.
    await makeStockLevel(product.id, location.id, { currentQuantity: 0 });
    await makeLedgerEntry(product.id, admin.id, {
      movementType: 'CHECKIN',
      quantity: 4,
      toLocationId: location.id,
    });

    const res = await as(admin).delete(`/api/products/${product.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Moved Once/);
    expect(res.body.error).toMatch(/movement/i);
    expect(res.body.error).toMatch(/[Dd]eactivate/);
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
