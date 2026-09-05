/**
 * Writing stock off the shelf.
 *
 * Until this movement type existed there was no honest way to record damage,
 * loss or a miscount. CHECKOUT is the only type that reduces stock, and it
 * refuses without a `referenceId` that resolves to a DISPATCHED shipment — so
 * correcting a count meant inventing a dispatch, which then appeared in the
 * outbound figures and, if the shipment was real, against a client.
 *
 * ADJUSTMENT is that movement without the lie: it leaves a bin, names no
 * shipment, and demands a reason instead.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeProduct,
  makeLocation,
  makeStockLevel,
} from '../factories/index.js';

const arrange = async ({ currentQuantity = 20, reservedQuantity = 0 } = {}) => {
  const admin = await makeAdmin();
  const { client } = await makeClient();
  const product = await makeProduct(client.id, { productName: 'Blue Tape' });
  const location = await makeLocation();
  const stock = await makeStockLevel(product.id, location.id, {
    currentQuantity,
    reservedQuantity,
  });
  return { admin, product, location, stock };
};

const writeOff = (admin, { product, location }, body = {}) =>
  as(admin).post('/api/inventory-ledgers').send({
    productId: product.id,
    movementType: 'ADJUSTMENT',
    quantity: 5,
    fromLocationId: location.id,
    notes: 'Crushed by a pallet truck',
    ...body,
  });

describe('stock adjustment', () => {
  it('lowers the stock and records the movement, with no shipment involved', async () => {
    const scenario = await arrange({ currentQuantity: 20 });

    const res = await writeOff(scenario.admin, scenario);

    expect(res.status).toBe(201);

    const stock = await prisma.stockLevel.findUnique({
      where: { id: scenario.stock.id },
    });
    expect(stock.currentQuantity).toBe(15);

    const [entry] = await prisma.inventoryLedger.findMany({
      where: { productId: scenario.product.id, movementType: 'ADJUSTMENT' },
    });
    expect(entry.quantity).toBe(5);
    expect(entry.fromLocationId).toBe(scenario.location.id);
    expect(entry.toLocationId).toBeNull();
    // The whole point: no shipment stands behind this one.
    expect(entry.referenceId).toBeNull();
    expect(entry.notes).toMatch(/pallet truck/);
  });

  it('cannot be written off out from under a shipment', async () => {
    // 20 on the shelf, 18 already reserved for a pick. Only 2 are genuinely
    // available; writing off 5 would leave the picker short tomorrow.
    const scenario = await arrange({ currentQuantity: 20, reservedQuantity: 18 });

    const res = await writeOff(scenario.admin, scenario, { quantity: 5 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/available/i);

    const stock = await prisma.stockLevel.findUnique({
      where: { id: scenario.stock.id },
    });
    expect(stock.currentQuantity).toBe(20);
  });

  it('takes the last available unit but not one more', async () => {
    const scenario = await arrange({ currentQuantity: 20, reservedQuantity: 18 });

    const ok = await writeOff(scenario.admin, scenario, { quantity: 2 });
    expect(ok.status).toBe(201);

    const tooMany = await writeOff(scenario.admin, scenario, { quantity: 1 });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);

    const stock = await prisma.stockLevel.findUnique({
      where: { id: scenario.stock.id },
    });
    expect(stock.currentQuantity).toBe(18);
  });

  it('refuses without a reason', async () => {
    // Nothing else corroborates a write-off. A CHECKOUT has a shipment, a
    // CHECKIN has a delivery; this has only what the operator typed, so an
    // empty reason is stock that simply vanished from the record.
    const scenario = await arrange();

    const res = await writeOff(scenario.admin, scenario, { notes: '   ' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/reason/i);

    const stock = await prisma.stockLevel.findUnique({
      where: { id: scenario.stock.id },
    });
    expect(stock.currentQuantity).toBe(20);
  });

  it('refuses without a location to take it from', async () => {
    const scenario = await arrange();

    const res = await writeOff(scenario.admin, scenario, { fromLocationId: null });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/fromLocationId/);
  });
});
