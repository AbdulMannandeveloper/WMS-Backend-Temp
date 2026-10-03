/**
 * SKUs and barcodes mean the same thing whatever the case.
 *
 * The screens already refused `abc-1` beside `ABC-1`, but the database did not,
 * so the API or a goods-in line could create a second product nobody could
 * tell apart — and a SKU typed at the scanner in the other case found nothing,
 * which invites creating that second product from the scan.
 *
 * Unlike emails, the stored spelling is kept: a SKU is the client's own
 * identifier and appears on their paperwork. Matching ignores case instead, and
 * expression indexes on lower() hold the rule in the database.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeProduct,
  makeWarehouseScenario,
} from '../factories/index.js';

const lookup = (actor, code) =>
  as(actor).get(`/api/products/lookup/barcode/${encodeURIComponent(code)}`);

describe('scanning or typing a code', () => {
  it('finds a SKU typed in a different case', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { skuCode: 'WIDGET-RED' });

    const res = await lookup(admin, 'widget-red');

    expect(res.status).toBe(200);
    expect(res.body.matchedOn).toBe('skuCode');
    expect(res.body.matches.map((m) => m.id)).toEqual([product.id]);
  });

  it('finds a barcode typed in a different case', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { barcode: 'X00ABC123' });

    const res = await lookup(admin, 'x00abc123');

    expect(res.status).toBe(200);
    expect(res.body.matchedOn).toBe('barcode');
    expect(res.body.matches.map((m) => m.id)).toEqual([product.id]);
  });

  it('treats _ and % in a code as themselves, not as wildcards', async () => {
    // Prisma's case-insensitive equals is ILIKE underneath, where _ matches any
    // one character. Unescaped, a scan of AB_1 would also return ABX1.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const wanted = await makeProduct(client.id, { skuCode: 'AB_1' });
    await makeProduct(client.id, { skuCode: 'ABX1' });
    await makeProduct(client.id, { skuCode: 'AB%1-LONGER' });

    const res = await lookup(admin, 'ab_1');

    expect(res.body.matches.map((m) => m.id)).toEqual([wanted.id]);
  });
});

describe('creating a product', () => {
  it('refuses a SKU the client already has in another case, naming the product', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient({ companyName: 'Acme' });
    await makeProduct(client.id, { skuCode: 'MUG-BLUE', productName: 'Blue Mug' });

    const res = await as(admin)
      .post('/api/products')
      .send({ clientId: client.id, skuCode: 'mug-blue', productName: 'Another mug' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MUG-BLUE/);
    expect(res.body.error).toMatch(/Blue Mug/);
    expect(await prisma.product.count({ where: { clientId: client.id } })).toBe(1);
  });

  it('allows the same SKU in another case for a different client', async () => {
    // SKUs are unique per client. Two clients may both call something mug-blue.
    const admin = await makeAdmin();
    const { client: a } = await makeClient();
    const { client: b } = await makeClient();
    await makeProduct(a.id, { skuCode: 'MUG-BLUE' });

    const res = await as(admin)
      .post('/api/products')
      .send({ clientId: b.id, skuCode: 'mug-blue', productName: 'Their mug' });

    expect(res.status).toBe(201);
  });

  it('refuses a barcode already on another product in another case', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    await makeProduct(client.id, { barcode: 'X00QWERTY', skuCode: 'HAS-CODE' });

    const res = await as(admin).post('/api/products').send({
      clientId: client.id,
      skuCode: 'NEW-ONE',
      productName: 'New',
      barcode: 'x00qwerty',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/HAS-CODE/);
  });

  it('keeps the SKU as entered, minus stray spaces', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    const res = await as(admin)
      .post('/api/products')
      .send({ clientId: client.id, skuCode: '  Tote-Bag-Lg ', productName: 'Tote', barcode: '  ' });

    expect(res.status).toBe(201);
    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row.skuCode).toBe('Tote-Bag-Lg');
    expect(row.barcode).toBeNull();
  });

  it('refuses a SKU of only spaces', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    const res = await as(admin)
      .post('/api/products')
      .send({ clientId: client.id, skuCode: '   ', productName: 'Nameless' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SKU Code are required/);
  });
});

describe('editing a product', () => {
  it('refuses a SKU change that clashes in another case', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    await makeProduct(client.id, { skuCode: 'CAP-BLACK' });
    const other = await makeProduct(client.id, { skuCode: 'CAP-WHITE' });

    const res = await as(admin).put(`/api/products/${other.id}`).send({ skuCode: 'cap-black' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already has a product with this SKU/);
  });

  it('refuses a barcode change that clashes in another case, naming the product', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    await makeProduct(client.id, {
      barcode: 'X00ZXCV',
      skuCode: 'HOLDER',
      productName: 'Code Holder',
    });
    const target = await makeProduct(client.id, { skuCode: 'WANTS-IT' });

    const res = await as(admin).put(`/api/products/${target.id}`).send({ barcode: 'x00zxcv' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/HOLDER/);
    expect(res.body.error).toMatch(/Code Holder/);
  });

  it('lets a product change the case of its own SKU', async () => {
    // Fixing `cap-red` to `CAP-RED` is an edit, not a clash with itself.
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id, { skuCode: 'cap-red' });

    const res = await as(admin).put(`/api/products/${product.id}`).send({ skuCode: 'CAP-RED' });

    expect(res.status).toBe(200);
    expect(res.body.skuCode).toBe('CAP-RED');
  });

  it('refuses blanking the SKU', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();
    const product = await makeProduct(client.id);

    const res = await as(admin).put(`/api/products/${product.id}`).send({ skuCode: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SKU Code cannot be blank/);
  });
});

describe('goods-in', () => {
  const post = (actor, body) => as(actor).post('/api/inventory-ledgers/batch').send(body);

  it('refuses a new product whose SKU the client has in another case', async () => {
    const { admin, client, location, product } = await makeWarehouseScenario({ quantity: 0 });

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        {
          newProduct: {
            clientId: client.id,
            skuCode: product.skuCode.toLowerCase(),
            productName: 'Duplicate in disguise',
          },
          quantity: 1,
        },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(product.skuCode));
    expect(await prisma.product.count({ where: { clientId: client.id } })).toBe(1);
  });

  it('names two lines whose barcodes differ only in case', async () => {
    const { admin, client, location } = await makeWarehouseScenario({ quantity: 0 });

    const res = await post(admin, {
      toLocationId: location.id,
      lines: [
        {
          newProduct: { clientId: client.id, skuCode: 'LINE-ONE', productName: 'One', barcode: 'X00LINE' },
          quantity: 1,
        },
        {
          newProduct: { clientId: client.id, skuCode: 'LINE-TWO', productName: 'Two', barcode: 'x00line' },
          quantity: 1,
        },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/line 1/i);
  });
});

describe('the database rule', () => {
  // Writes that go around the application still cannot create the duplicate.
  it('refuses a SKU that differs only in case for the same client', async () => {
    const { client } = await makeClient();
    await makeProduct(client.id, { skuCode: 'RAW-SKU' });

    await expect(makeProduct(client.id, { skuCode: 'raw-sku' })).rejects.toThrow(
      /uq_products_client_sku_ci|lower\(sku_code/,
    );
  });

  it('refuses a barcode that differs only in case', async () => {
    const { client } = await makeClient();
    await makeProduct(client.id, { barcode: 'RAW-CODE' });

    await expect(makeProduct(client.id, { barcode: 'raw-code' })).rejects.toThrow(
      /uq_products_barcode_ci|lower\(barcode/,
    );
  });
});
