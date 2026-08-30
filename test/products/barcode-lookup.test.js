/**
 * Resolving a scanned code to a product.
 *
 * The endpoint existed before the scanner did, and had no caller. It fell back
 * from barcode to SKU and then returned `products[0]` — but `barcode` is
 * globally unique while `skuCode` is unique only within a client
 * (`@@unique([clientId, skuCode])`). Two clients stocking the same SKU meant the
 * endpoint silently returned whichever row came first.
 *
 * In a 3PL that is a billing error waiting to happen: check stock in against the
 * wrong client's product and it lands in their inventory, and eventually on
 * their invoice, and nobody notices until it is disputed.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeUser,
  makeClient,
  makeProduct,
  makeLocation,
  makeStockLevel,
} from '../factories/index.js';

describe('barcode lookup', () => {
  it('resolves a barcode to exactly that product', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, {
      barcode: '5012345678900',
      skuCode: 'WIDGET-1',
    });

    const res = await as(admin).get('/api/products/lookup/barcode/5012345678900');

    expect(res.status).toBe(200);
    expect(res.body.matchedOn).toBe('barcode');
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].id).toBe(product.id);
  });

  it('returns BOTH products when two clients share a SKU', async () => {
    // The regression this endpoint's rewrite exists for.
    const admin = await makeAdmin();
    const { client: clientA } = await makeClient({ companyName: 'Acme' });
    const { client: clientB } = await makeClient({ companyName: 'Beta Freight' });

    await makeProduct(clientA.id, { skuCode: 'SHARED-SKU', productName: "Acme's" });
    await makeProduct(clientB.id, { skuCode: 'SHARED-SKU', productName: "Beta's" });

    const res = await as(admin).get('/api/products/lookup/barcode/SHARED-SKU');

    expect(res.status).toBe(200);
    expect(res.body.matchedOn).toBe('skuCode');
    expect(res.body.matches).toHaveLength(2);

    const owners = res.body.matches.map((m) => m.client.companyName).sort();
    expect(owners).toEqual(['Acme', 'Beta Freight']);
  });

  it('prefers a barcode hit over a SKU that collides with it', async () => {
    const admin = await makeAdmin();
    const { client: a } = await makeClient({ companyName: 'Acme' });
    const { client: b } = await makeClient({ companyName: 'Beta Freight' });

    // One product's barcode happens to equal another's SKU.
    const barcoded = await makeProduct(a.id, { barcode: 'CODE-999', skuCode: 'A-1' });
    await makeProduct(b.id, { skuCode: 'CODE-999' });

    const res = await as(admin).get('/api/products/lookup/barcode/CODE-999');

    // A barcode is unambiguous by construction, so it is returned alone.
    expect(res.body.matchedOn).toBe('barcode');
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].id).toBe(barcoded.id);
  });

  it('returns one match for a SKU only one client uses', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    await makeProduct(client.id, { skuCode: 'UNIQUE-SKU' });

    const res = await as(admin).get('/api/products/lookup/barcode/UNIQUE-SKU');

    expect(res.body.matches).toHaveLength(1);
  });

  it('carries the client and the stock-by-location the picker needs', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient({ companyName: 'Acme' });
    const product = await makeProduct(client.id, { barcode: '5011111111111' });
    const location = await makeLocation();
    await makeStockLevel(product.id, location.id, { currentQuantity: 42 });

    const res = await as(admin).get('/api/products/lookup/barcode/5011111111111');

    const match = res.body.matches[0];
    expect(match.client.companyName).toBe('Acme');
    expect(match.stockLevels).toHaveLength(1);
    expect(match.stockLevels[0].currentQuantity).toBe(42);
    expect(match.stockLevels[0].location.locationName).toBeTruthy();
  });

  it('404s an unknown code', async () => {
    const admin = await makeAdmin();

    const res = await as(admin).get('/api/products/lookup/barcode/NOT-A-REAL-CODE');

    expect(res.status).toBe(404);
  });

  describe('who can resolve what', () => {
    it('refuses a client — scanning is a warehouse operation', async () => {
      const { user: clientUser, client } = await makeClient();
      await makeProduct(client.id, { barcode: '5012222222222', skuCode: 'MINE' });

      const res = await as(clientUser).get('/api/products/lookup/barcode/5012222222222');

      // The route is staff-only: there is no scanner in the client portal, and
      // a client browsing their own catalogue uses GET /api/products, which is
      // already scoped to them.
      expect(res.status).toBe(403);
    });

    it('an employee may scan, an anonymous caller may not', async () => {
      const employee = await makeUser({ role: 'employee' });
      const { client } = await makeClient();
      await makeProduct(client.id, { barcode: '5014444444444' });

      await expect(
        as(employee)
          .get('/api/products/lookup/barcode/5014444444444')
          .then((r) => r.status),
      ).resolves.toBe(200);
      await expect(
        anon().get('/api/products/lookup/barcode/5014444444444').then((r) => r.status),
      ).resolves.toBe(401);
    });
  });

  describe('attaching a barcode to an existing product', () => {
    it('binds a scanned code to a product that had none', async () => {
      const admin = await makeAdmin();
      const { client } = await makeClient();
      const product = await makeProduct(client.id, { skuCode: 'NO-CODE-YET' });

      const res = await as(admin)
        .put(`/api/products/${product.id}`)
        .send({ barcode: '5015555555555' });

      expect(res.status).toBe(200);

      // And it now resolves.
      const found = await as(admin).get('/api/products/lookup/barcode/5015555555555');
      expect(found.body.matches[0].id).toBe(product.id);
    });

    it('refuses a barcode already on another product, naming it', async () => {
      const admin = await makeAdmin();
      const { client } = await makeClient();
      await makeProduct(client.id, {
        barcode: '5016666666666',
        skuCode: 'TAKEN-SKU',
        productName: 'Existing Widget',
      });
      const target = await makeProduct(client.id, { skuCode: 'OTHER-SKU' });

      const res = await as(admin)
        .put(`/api/products/${target.id}`)
        .send({ barcode: '5016666666666' });

      expect(res.status).toBe(400);
      // Naming the other product is the difference between an actionable error
      // and a raw unique-constraint failure.
      expect(res.body.error).toMatch(/TAKEN-SKU/);
      expect(res.body.error).toMatch(/Existing Widget/);
    });

    it('lets a product keep its own barcode on an unrelated edit', async () => {
      const admin = await makeAdmin();
      const { client } = await makeClient();
      const product = await makeProduct(client.id, { barcode: '5017777777777' });

      const res = await as(admin)
        .put(`/api/products/${product.id}`)
        .send({ barcode: '5017777777777', productName: 'Renamed' });

      expect(res.status).toBe(200);
    });
  });

  describe('checking stock in against a scanned product', () => {
    it('raises on-hand stock and writes a CHECKIN ledger row', async () => {
      // The check-in path needs no new endpoint — this covers it end to end.
      const admin = await makeAdmin();
      const { client } = await makeClient();
      const product = await makeProduct(client.id, { barcode: '5018888888888' });
      const location = await makeLocation();
      await makeStockLevel(product.id, location.id, { currentQuantity: 5 });

      const res = await as(admin).post('/api/inventory-ledgers').send({
        productId: product.id,
        movementType: 'CHECKIN',
        quantity: 7,
        toLocationId: location.id,
      });

      expect(res.status).toBe(201);

      const stock = await prisma.stockLevel.findFirst({
        where: { productId: product.id, locationId: location.id },
      });
      expect(stock.currentQuantity).toBe(12);

      const ledger = await prisma.inventoryLedger.findMany({
        where: { productId: product.id, movementType: 'CHECKIN' },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].userId).toBe(admin.id);
    });
  });
});
