/**
 * Return handling — the Returns tab.
 *
 * What must hold:
 *   - Nothing about a return is typed in. The RET- number, the client, the rate
 *     and the invoice are all derived; the body carries only what was scanned.
 *   - Recording charges the client's ITEM_RETURN rate; restocking charges their
 *     RETURN_RESTOCK rate on top; disposing charges nothing further. No agreed
 *     rate, no charge.
 *   - A restock puts the units on the shelf in the same transaction; a disposal
 *     never touches stock.
 *   - A tracking number that matches a dispatched shipment links the return to
 *     that line and counts against it, so the line cannot come back twice.
 *   - Employees never see what a client pays.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeClient,
  makeProduct,
  makeLocation,
  makeClientService,
  makeEmployee,
  grantPermissions,
} from '../factories/index.js';
import billingServices from '../../logic/billing_services.js';

const { ensureReturnService, ensureRestockService } = billingServices;

const giveRates = async (clientId, { handling = null, restock = null } = {}) => {
  if (handling !== null) {
    const service = await ensureReturnService();
    await makeClientService(clientId, service.id, { chargedPrice: handling, unit: 'item' });
  }
  if (restock !== null) {
    const service = await ensureRestockService();
    await makeClientService(clientId, service.id, { chargedPrice: restock, unit: 'item' });
  }
};

const record = (actor, body) => as(actor).post('/api/returns').send(body);

const returnLines = (returnId) =>
  prisma.invoiceLineItem.findMany({ where: { returnId }, orderBy: { totalPrice: 'asc' } });

const onHandAt = async (productId, locationId) => {
  const level = await prisma.stockLevel.findUnique({
    where: { productId_locationId: { productId, locationId } },
  });
  return level?.currentQuantity ?? 0;
};

/** A shipment of `quantity` dispatched through the API, carrying a tracking number. */
const dispatchWithTracking = async (s, { quantity = 5, trackingId = 'RM123456789GB' } = {}) => {
  const created = await as(s.admin)
    .post('/api/shipments')
    .send({
      trackingId,
      shipmentItems: [
        { productId: s.product.id, sourceLocationId: s.location.id, quantity },
      ],
    });
  expect(created.status).toBe(201);
  const item = await prisma.shipmentItem.findFirst({ where: { shipmentId: created.body.id } });
  return { shipment: created.body, item };
};

describe('recording a return', () => {
  it('issues a RET- number and takes the client from the product', async () => {
    const s = await makeWarehouseScenario();

    const res = await record(s.admin, {
      trackingNumber: 'TRK 0001',
      productId: s.product.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^RET-\d{4}-\d{6}$/);
    expect(res.body.clientId).toBe(s.client.id);
    expect(res.body.status).toBe('RECORDED');
    expect(res.body.quantity).toBe(1);
    // Spaces a courier prints between groups are not part of the number.
    expect(res.body.trackingNumber).toBe('TRK0001');
  });

  it('numbers returns in sequence', async () => {
    const s = await makeWarehouseScenario();

    const a = await record(s.admin, { trackingNumber: 'A1', productId: s.product.id });
    const b = await record(s.admin, { trackingNumber: 'B2', productId: s.product.id });

    const tail = (ref) => Number(ref.split('-').pop());
    expect(tail(b.body.reference)).toBe(tail(a.body.reference) + 1);
  });

  it('ignores a client or reference sent in the body', async () => {
    const s = await makeWarehouseScenario();
    const { client: other } = await makeClient({ companyName: 'Other Co' });

    const res = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      clientId: other.id,
      reference: 'RET-1999-999999',
    });

    expect(res.status).toBe(201);
    expect(res.body.clientId).toBe(s.client.id);
    expect(res.body.reference).not.toBe('RET-1999-999999');
  });

  it('refuses without a tracking number or a product', async () => {
    const s = await makeWarehouseScenario();

    expect((await record(s.admin, { productId: s.product.id })).status).toBe(400);
    expect((await record(s.admin, { trackingNumber: 'T1' })).status).toBe(400);
  });

  it('charges the ITEM_RETURN rate × quantity onto the open invoice', async () => {
    const s = await makeWarehouseScenario();
    await giveRates(s.client.id, { handling: '1.50' });

    const res = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      quantity: 3,
    });

    expect(res.status).toBe(201);
    expect(res.body.charged).toBe(4.5);

    const lines = await returnLines(res.body.id);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].totalPrice)).toBe(4.5);
    expect(lines[0].itemType).toBe('AUTOMATED_SERVICE');

    const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: lines[0].invoiceId } });
    expect(invoice.clientId).toBe(s.client.id);
    expect(Number(invoice.totalAmount)).toBe(4.5);
  });

  it('charges nothing when the client has no agreed rate', async () => {
    const s = await makeWarehouseScenario();

    const res = await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });

    expect(res.status).toBe(201);
    expect(res.body.charged).toBeNull();
    expect(await returnLines(res.body.id)).toHaveLength(0);
    expect(await prisma.monthlyInvoice.count({ where: { clientId: s.client.id } })).toBe(0);
  });

  it('does not touch stock', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });

    await record(s.admin, { trackingNumber: 'T1', productId: s.product.id, quantity: 2 });

    expect(await onHandAt(s.product.id, s.location.id)).toBe(10);
  });
});

describe('matching the tracking number to a dispatched shipment', () => {
  it('links the return to the line and counts it as come back', async () => {
    const s = await makeWarehouseScenario();
    const { shipment, item } = await dispatchWithTracking(s, { quantity: 5 });

    const res = await record(s.admin, {
      trackingNumber: 'RM123456789GB',
      productId: s.product.id,
      quantity: 2,
    });

    expect(res.status).toBe(201);
    expect(res.body.shipmentId).toBe(shipment.id);
    expect(res.body.shipmentItemId).toBe(item.id);

    const after = await prisma.shipmentItem.findUnique({ where: { id: item.id } });
    expect(after.returnedQuantity).toBe(2);
  });

  it('refuses more than is still out on the line', async () => {
    const s = await makeWarehouseScenario();
    await dispatchWithTracking(s, { quantity: 3 });

    await record(s.admin, { trackingNumber: 'RM123456789GB', productId: s.product.id, quantity: 2 });
    const over = await record(s.admin, {
      trackingNumber: 'RM123456789GB',
      productId: s.product.id,
      quantity: 2,
    });

    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/Only 1/);
  });

  it("refuses a product that is not the tracked shipment's client's", async () => {
    const s = await makeWarehouseScenario();
    await dispatchWithTracking(s);
    const { client: other } = await makeClient({ companyName: 'Other Co' });
    const foreign = await makeProduct(other.id);

    const res = await record(s.admin, { trackingNumber: 'RM123456789GB', productId: foreign.id });

    expect(res.status).toBe(409);
    expect(await prisma.productReturn.count()).toBe(0);
  });

  it('records without a link when the number matches nothing', async () => {
    const s = await makeWarehouseScenario();

    const res = await record(s.admin, { trackingNumber: 'NEVER-SEEN', productId: s.product.id });

    expect(res.status).toBe(201);
    expect(res.body.shipmentId).toBeNull();
    expect(res.body.shipmentItemId).toBeNull();
  });
});

describe('identify', () => {
  it('names the client and shows the rates to an admin', async () => {
    const s = await makeWarehouseScenario();
    await prisma.product.update({ where: { id: s.product.id }, data: { barcode: '5012345678900' } });
    await giveRates(s.client.id, { handling: '1.50', restock: '0.75' });

    const res = await as(s.admin).get('/api/returns/identify?tracking=X1&code=5012345678900');

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].client.id).toBe(s.client.id);
    expect(res.body.products[0].rates).toEqual({ returnHandling: 1.5, restock: 0.75 });
  });

  it('finds the dispatched shipment from the tracking number alone', async () => {
    const s = await makeWarehouseScenario();
    const { shipment } = await dispatchWithTracking(s);

    const res = await as(s.admin).get('/api/returns/identify?tracking=RM123456789GB');

    expect(res.status).toBe(200);
    expect(res.body.shipment.id).toBe(shipment.id);
    expect(res.body.shipment.client.id).toBe(s.client.id);
  });

  it('writes nothing', async () => {
    const s = await makeWarehouseScenario();
    await as(s.admin).get(`/api/returns/identify?tracking=X1&code=${s.product.skuCode}`);
    expect(await prisma.productReturn.count()).toBe(0);
  });
});

describe('disposing of a return', () => {
  it('closes it, charges nothing further and leaves stock alone', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.50', restock: '0.75' });
    const recorded = await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });

    const res = await as(s.admin).post(`/api/returns/${recorded.body.id}/dispose`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPOSED');
    expect(res.body.resolvedAt).toBeTruthy();
    // Only the handling charge from recording.
    expect(await returnLines(recorded.body.id)).toHaveLength(1);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(10);
  });

  it('cannot be resolved a second time', async () => {
    const s = await makeWarehouseScenario();
    const recorded = await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });

    await as(s.admin).post(`/api/returns/${recorded.body.id}/dispose`).send({});
    const again = await as(s.admin)
      .post(`/api/returns/${recorded.body.id}/restock`)
      .send({ locationId: s.location.id });

    expect(again.status).toBe(409);
  });
});

describe('inspecting and restocking a return', () => {
  it('puts the units on the shelf and raises the restock charge', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.50', restock: '0.75' });
    const recorded = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      quantity: 2,
    });

    const res = await as(s.admin)
      .post(`/api/returns/${recorded.body.id}/restock`)
      .send({ locationId: s.location.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RESTOCKED');
    expect(res.body.restockLocation.id).toBe(s.location.id);
    expect(res.body.charged).toBe(1.5);

    expect(await onHandAt(s.product.id, s.location.id)).toBe(12);

    const movement = await prisma.inventoryLedger.findFirst({
      where: { referenceId: recorded.body.reference },
    });
    expect(movement.movementType).toBe('RETURN');
    expect(movement.quantity).toBe(2);

    const lines = await returnLines(recorded.body.id);
    expect(lines.map((l) => Number(l.totalPrice))).toEqual([1.5, 3]);
    const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: lines[0].invoiceId } });
    expect(Number(invoice.totalAmount)).toBe(4.5);
  });

  it('creates the stock record when the product was never in that bin', async () => {
    const s = await makeWarehouseScenario();
    const elsewhere = await makeLocation();
    const recorded = await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });

    await as(s.admin)
      .post(`/api/returns/${recorded.body.id}/restock`)
      .send({ locationId: elsewhere.id });

    expect(await onHandAt(s.product.id, elsewhere.id)).toBe(1);
  });

  it('refuses without a location, and changes nothing', async () => {
    const s = await makeWarehouseScenario();
    const recorded = await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });

    const res = await as(s.admin).post(`/api/returns/${recorded.body.id}/restock`).send({});

    expect(res.status).toBe(400);
    const row = await prisma.productReturn.findUnique({ where: { id: recorded.body.id } });
    expect(row.status).toBe('RECORDED');
  });

  it('stops its shipment being deleted until the return is dealt with', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment } = await dispatchWithTracking(s, { quantity: 5 });
    // 10 - 5 dispatched.
    expect(await onHandAt(s.product.id, s.location.id)).toBe(5);

    const recorded = await record(s.admin, {
      trackingNumber: 'RM123456789GB',
      productId: s.product.id,
      quantity: 2,
    });
    await as(s.admin)
      .post(`/api/returns/${recorded.body.id}/restock`)
      .send({ locationId: s.location.id });
    expect(await onHandAt(s.product.id, s.location.id)).toBe(7);

    const res = await as(s.admin).delete(`/api/shipments/${shipment.id}`);

    // Refused, and nothing moved: the return names the shipment and carries
    // its own charges, so it goes first.
    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['returns']);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(7);
  });
});

describe('what the disposition step is told', () => {
  it('suggests the bin the matched line was picked from, and the restock rate', async () => {
    const s = await makeWarehouseScenario();
    await giveRates(s.client.id, { restock: '0.75' });
    await dispatchWithTracking(s);
    const recorded = await record(s.admin, {
      trackingNumber: 'RM123456789GB',
      productId: s.product.id,
    });

    expect(recorded.body.suggestedLocationId).toBe(s.location.id);
    expect(recorded.body.rates.restock).toBe(0.75);

    const read = await as(s.admin).get(`/api/returns/${recorded.body.id}`);
    expect(read.body.suggestedLocationId).toBe(s.location.id);
  });

  it('is not repeated once the return is resolved', async () => {
    const s = await makeWarehouseScenario();
    const recorded = await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });
    await as(s.admin).post(`/api/returns/${recorded.body.id}/dispose`).send({});

    const read = await as(s.admin).get(`/api/returns/${recorded.body.id}`);
    expect(read.body.rates).toBeUndefined();
  });
});

describe('recording with the disposition in one step (the bench flow)', () => {
  it('records and restocks together: both charges, stock back, status final', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.50', restock: '0.75' });

    const res = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      quantity: 2,
      disposition: { type: 'restock', locationId: s.location.id },
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('RESTOCKED');
    expect(res.body.restockLocation.id).toBe(s.location.id);
    // Handling 2 × 1.50 plus restock 2 × 0.75.
    expect(res.body.charged).toBe(4.5);
    expect(await returnLines(res.body.id)).toHaveLength(2);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(12);
  });

  it('records and disposes together: only the handling charge, stock untouched', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.50', restock: '0.75' });

    const res = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      disposition: { type: 'dispose', notes: 'Crushed' },
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DISPOSED');
    expect(res.body.dispositionNotes).toBe('Crushed');
    expect(res.body.charged).toBe(1.5);
    expect(await returnLines(res.body.id)).toHaveLength(1);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(10);
  });

  it('writes nothing at all when the disposition is refused', async () => {
    const s = await makeWarehouseScenario();
    await giveRates(s.client.id, { handling: '1.50' });

    const res = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      disposition: { type: 'restock' },
    });

    expect(res.status).toBe(400);
    expect(await prisma.productReturn.count()).toBe(0);
    expect(await prisma.invoiceLineItem.count()).toBe(0);
  });

  it('refuses an unknown disposition', async () => {
    const s = await makeWarehouseScenario();

    const res = await record(s.admin, {
      trackingNumber: 'T1',
      productId: s.product.id,
      disposition: { type: 'keep' },
    });

    expect(res.status).toBe(400);
    expect(await prisma.productReturn.count()).toBe(0);
  });

  it('needs returns:update as well as create', async () => {
    const s = await makeWarehouseScenario();
    const { user } = await makeEmployee();
    await grantPermissions(user, 'returns:create', 'returns:read');

    const res = await record(user, {
      trackingNumber: 'T1',
      productId: s.product.id,
      disposition: { type: 'dispose' },
    });

    expect(res.status).toBe(403);
    expect(await prisma.productReturn.count()).toBe(0);
  });
});

describe('identify, for a decision made before anything is written', () => {
  it('suggests the bin the matched line was picked from', async () => {
    const s = await makeWarehouseScenario();
    await dispatchWithTracking(s);

    const res = await as(s.admin).get(
      `/api/returns/identify?tracking=RM123456789GB&code=${s.product.skuCode}`,
    );

    expect(res.body.products[0].suggestedLocationId).toBe(s.location.id);
  });
});

describe('who may do what', () => {
  it('refuses an employee who holds no returns permission', async () => {
    const s = await makeWarehouseScenario({ permissions: [] });

    const res = await record(s.employeeUser, { trackingNumber: 'T1', productId: s.product.id });

    expect(res.status).toBe(403);
  });

  it('refuses a client', async () => {
    const s = await makeWarehouseScenario();
    expect((await as(s.clientUser).get('/api/returns')).status).toBe(403);
  });

  it('lets an employee record, but never shows them what the client pays', async () => {
    const s = await makeWarehouseScenario();
    const { user } = await makeEmployee();
    await grantPermissions(user, 'returns:create', 'returns:read');
    await giveRates(s.client.id, { handling: '1.50' });

    const res = await record(user, { trackingNumber: 'T1', productId: s.product.id });

    expect(res.status).toBe(201);
    expect(res.body.charged).toBe(true);
    expect(res.body.invoiceLines).toBeUndefined();

    // The restock rate the disposition step shows is a flag, not a price.
    expect(res.body.rates).toEqual({ returnHandling: true, restock: null });

    const list = await as(user).get('/api/returns');
    expect(list.body[0].invoiceLines).toBeUndefined();
    expect(list.body[0].charged).toBe(true);
  });
});

describe('the product it references', () => {
  it('cannot be deleted while a return names it', async () => {
    const s = await makeWarehouseScenario();
    await record(s.admin, { trackingNumber: 'T1', productId: s.product.id });

    const res = await as(s.admin).delete(`/api/products/${s.product.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/return/);
  });
});
