/**
 * Booking a whole delivery in at once.
 *
 * A pallet turns up carrying ten different SKUs. Doing that one request per
 * carton was slow at the bench and, worse, left the door open to a delivery
 * that is half received — six lines on the shelf, line seven rejected, and
 * nobody sure what is actually there.
 *
 * So the interesting tests here are not the happy path. They are: does a bad
 * line take the whole batch back, and can a product be created and filled in
 * the same breath.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeLocation,
  makeProduct,
} from '../factories/index.js';

/**
 * Two products belonging to one client, an empty bin, and staff to receive
 * into it. Deliberately no stock on hand: these tests assert what arrives.
 */
const arrange = async () => {
  const scenario = await makeWarehouseScenario({ quantity: 0 });
  const productB = await makeProduct(scenario.client.id, { skuCode: 'SKU-B' });

  return {
    admin: scenario.admin,
    employeeUser: scenario.employeeUser,
    client: scenario.client,
    location: scenario.location,
    productA: scenario.product,
    productB,
  };
};

const onHand = async (productId) => {
  const { _sum } = await prisma.stockLevel.aggregate({
    where: { productId },
    _sum: { currentQuantity: true },
  });
  return _sum.currentQuantity ?? 0;
};

const post = (actor, body) => as(actor).post('/api/inventory-ledgers/batch').send(body);

describe('receiving a delivery', () => {
  it('books every line in and moves the stock', async () => {
    const { admin, location, productA, productB } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        { productId: productA.id, quantity: 3 },
        { productId: productB.id, quantity: 5 },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.linesReceived).toBe(2);
    expect(await onHand(productA.id)).toBe(3);
    expect(await onHand(productB.id)).toBe(5);
  });

  it('writes one CHECKIN movement per line, so the trail matches the shelf', async () => {
    const { admin, location, productA } = await arrange();

    await post(admin, {
      toLocationId: location.id,
      lines: [{ productId: productA.id, quantity: 7 }],
    });

    const movements = await prisma.inventoryLedger.findMany({
      where: { productId: productA.id, movementType: 'CHECKIN' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(7);
    expect(movements[0].toLocationId).toBe(location.id);
  });

  it('lets a line override the session location', async () => {
    const { admin, location, productA, productB } = await arrange();
    const other = await makeLocation();

    await post(admin, {
      toLocationId: location.id,
      lines: [
        { productId: productA.id, quantity: 1 },
        { productId: productB.id, quantity: 1, toLocationId: other.id },
      ],
    });

    const b = await prisma.stockLevel.findFirst({
      where: { productId: productB.id },
    });
    expect(b.locationId).toBe(other.id);
  });
});

describe('a new product arriving on the pallet', () => {
  it('is created and filled in the same call', async () => {
    // This is the one that fails against the old code. The ledger validates
    // that the product exists, and it used to look it up outside the
    // transaction — so a product created a line earlier was invisible and the
    // movement was refused with "Provided product not found."
    const { admin, client, location } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        {
          newProduct: {
            clientId: client.id,
            skuCode: 'SKU-NEW',
            productName: 'Jiffy Bags',
            barcode: '5012345678900',
          },
          quantity: 12,
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.productsCreated).toBe(1);

    const created = await prisma.product.findFirst({
      where: { clientId: client.id, skuCode: 'SKU-NEW' },
    });
    expect(created).toBeTruthy();
    expect(created.barcode).toBe('5012345678900');
    expect(await onHand(created.id)).toBe(12);
  });

  it('takes new and existing products in one delivery', async () => {
    const { admin, client, location, productA } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        { productId: productA.id, quantity: 2 },
        {
          newProduct: {
            clientId: client.id,
            skuCode: 'SKU-MIXED',
            productName: 'Mailers',
          },
          quantity: 4,
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ linesReceived: 2, productsCreated: 1 });
  });
});

describe('nothing lands when anything is wrong', () => {
  it('rolls the whole delivery back when one line names a missing product', async () => {
    const { admin, location, productA } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        { productId: productA.id, quantity: 5 },
        { productId: '00000000-0000-0000-0000-000000000000', quantity: 5 },
      ],
    });

    expect(res.status).toBe(400);
    // The good line must not survive: a half-received pallet is worse than a
    // refused one, because nobody knows which half.
    expect(await onHand(productA.id)).toBe(0);
    expect(
      await prisma.inventoryLedger.count({ where: { productId: productA.id } }),
    ).toBe(0);
  });

  it('creates no products when a later line fails', async () => {
    const { admin, client, location } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        {
          newProduct: {
            clientId: client.id,
            skuCode: 'SKU-ROLLBACK',
            productName: 'Should not exist',
          },
          quantity: 1,
        },
        { productId: '00000000-0000-0000-0000-000000000000', quantity: 1 },
      ],
    });

    expect(res.status).toBe(400);
    expect(
      await prisma.product.findFirst({ where: { skuCode: 'SKU-ROLLBACK' } }),
    ).toBeNull();
  });

  it('refuses a quantity of zero rather than writing a movement of nothing', async () => {
    const { admin, location, productA } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [{ productId: productA.id, quantity: 0 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/quantity/i);
  });

  it('refuses an empty basket', async () => {
    const { admin, location } = await arrange();

    const res = await post(admin, { toLocationId: location.id, lines: [] });
    expect(res.status).toBe(400);
  });

  it('refuses a line with nowhere to put the stock', async () => {
    const { admin, productA } = await arrange();

    const res = await post(admin, { lines: [{ productId: productA.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  it('names the two lines that repeat a SKU rather than letting Postgres reject it', async () => {
    const { admin, client, location } = await arrange();

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        {
          newProduct: { clientId: client.id, skuCode: 'SKU-DUP', productName: 'One' },
          quantity: 1,
        },
        {
          newProduct: { clientId: client.id, skuCode: 'SKU-DUP', productName: 'Two' },
          quantity: 1,
        },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SKU-DUP/);
    expect(res.body.error).toMatch(/line 1/i);
  });
});

describe('who may receive stock', () => {
  it('allows an employee — this is their job', async () => {
    const { location, productA, employeeUser } = await arrange();

    const res = await post(employeeUser, {
      toLocationId: location.id,
      lines: [{ productId: productA.id, quantity: 1 }],
    });

    expect(res.status).toBe(201);
  });

  it('records the movement against whoever was signed in, not the body', async () => {
    const { location, productA, employeeUser } = await arrange();

    await post(employeeUser, {
      toLocationId: location.id,
      // A body claiming to be somebody else must be ignored.
      userId: '00000000-0000-0000-0000-000000000000',
      lines: [{ productId: productA.id, quantity: 1 }],
    });

    const movement = await prisma.inventoryLedger.findFirst({
      where: { productId: productA.id },
    });
    expect(movement.userId).toBe(employeeUser.id);
  });

  it('refuses an unauthenticated request', async () => {
    const { location, productA } = await arrange();

    const res = await anon()
      .post('/api/inventory-ledgers/batch')
      .send({ toLocationId: location.id, lines: [{ productId: productA.id, quantity: 1 }] });

    expect([401, 403]).toContain(res.status);
  });
});
