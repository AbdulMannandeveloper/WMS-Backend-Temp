/**
 * Deleting a return, and undoing the returns booked on a shipment's lines.
 *
 * Both exist to take back a return that should never have been booked. What
 * must hold:
 *   - everything booking it did is undone: restocked units come back off the
 *     shelf (an ADJUSTMENT after the RETURN, never a rewrite of it), its charges
 *     come off unpaid invoices, and the shipment line counts the units as out
 *   - a charge on a PAID invoice refuses it, as it refuses a shipment delete
 *   - so do restocked units no longer free on the shelf
 *   - once undone, the shipment the returns blocked can be deleted
 *
 * The line's Return button books a return record too, so it is deleted the
 * same way. The shipment-level undo is only for what that button booked
 * before it made records.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeWarehouseScenario, makeClientService, makeInvoice } from '../factories/index.js';
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

const onHandAt = async (productId, locationId) =>
  (
    await prisma.stockLevel.findUnique({
      where: { productId_locationId: { productId, locationId } },
    })
  )?.currentQuantity ?? 0;

const TRACKING = 'RM123456789GB';

/** 10 on the shelf, 5 dispatched against TRACKING. */
const dispatched = async (s) => {
  const created = await as(s.admin)
    .post('/api/shipments')
    .send({
      trackingId: TRACKING,
      shipmentItems: [{ productId: s.product.id, sourceLocationId: s.location.id, quantity: 5 }],
    });
  expect(created.status).toBe(201);
  const item = await prisma.shipmentItem.findFirst({ where: { shipmentId: created.body.id } });
  return { shipment: created.body, item };
};

/** A return of 2 against TRACKING, restocked into the bin they were picked from. */
const restockedReturn = async (s) => {
  const res = await as(s.admin)
    .post('/api/returns')
    .send({
      trackingNumber: TRACKING,
      productId: s.product.id,
      quantity: 2,
      disposition: { type: 'restock', locationId: s.location.id },
    });
  expect(res.status).toBe(201);
  return res.body;
};

describe('deleting a return', () => {
  it('undoes a restock: units off the shelf, charges off, the line counts them out again', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.00', restock: '0.50' });
    const { item } = await dispatched(s);
    const ret = await restockedReturn(s);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(7);
    const invoiceId = (await prisma.invoiceLineItem.findFirst({ where: { returnId: ret.id } }))
      .invoiceId;

    const warning = await as(s.admin).get(`/api/returns/${ret.id}/dependents`);
    expect(warning.status).toBe(200);
    expect(warning.body.canDelete).toBe(true);
    expect(Object.fromEntries(warning.body.removedWith.map((r) => [r.key, r.count]))).toMatchObject(
      { units: 2, charges: 2, lineCount: 2 },
    );

    const res = await as(s.admin).delete(`/api/returns/${ret.id}`);

    expect(res.status).toBe(200);
    expect(await prisma.productReturn.findUnique({ where: { id: ret.id } })).toBeNull();
    expect(await onHandAt(s.product.id, s.location.id)).toBe(5);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(0);
    expect(await prisma.invoiceLineItem.count({ where: { description: { contains: ret.reference } } })).toBe(0);

    // The RETURN stays in the ledger, followed by the ADJUSTMENT reversing it.
    const moves = await prisma.inventoryLedger.findMany({
      where: { referenceId: ret.reference },
      orderBy: { timestamp: 'asc' },
    });
    expect(moves.map((m) => m.movementType)).toEqual(['RETURN', 'ADJUSTMENT']);

    // The invoice is recomputed from what is left on it.
    const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: invoiceId } });
    const { _sum } = await prisma.invoiceLineItem.aggregate({
      where: { invoiceId },
      _sum: { totalPrice: true },
    });
    expect(Number(invoice.totalAmount)).toBe(Number(_sum.totalPrice ?? 0));
  });

  it("re-renders an approved invoice's stored PDF so it stops billing the deleted return", async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.00' });
    await dispatched(s);
    const ret = await restockedReturn(s);
    const { invoiceId } = await prisma.invoiceLineItem.findFirst({ where: { returnId: ret.id } });

    const approved = await as(s.admin).post(`/api/monthly-invoices/${invoiceId}/approve`);
    expect(approved.status).toBe(200);

    const download = async () => {
      const res = await as(s.admin)
        .get(`/api/monthly-invoices/${invoiceId}/pdf`)
        .buffer()
        .parse((r, cb) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      return res.body.toString('latin1');
    };
    expect(await download()).toContain(ret.reference);

    expect((await as(s.admin).delete(`/api/returns/${ret.id}`)).status).toBe(200);

    expect(await download()).not.toContain(ret.reference);
  });

  it('touches no stock for a disposed return', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await dispatched(s);
    const recorded = await as(s.admin)
      .post('/api/returns')
      .send({ trackingNumber: TRACKING, productId: s.product.id, disposition: { type: 'dispose' } });

    const res = await as(s.admin).delete(`/api/returns/${recorded.body.id}`);

    expect(res.status).toBe(200);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(5);
    expect(
      await prisma.inventoryLedger.count({ where: { referenceId: recorded.body.reference } }),
    ).toBe(0);
  });

  it('is refused while a charge for it is on a paid invoice', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.00' });
    await dispatched(s);
    const ret = await restockedReturn(s);
    const line = await prisma.invoiceLineItem.findFirst({ where: { returnId: ret.id } });
    await prisma.monthlyInvoice.update({ where: { id: line.invoiceId }, data: { status: 'PAID' } });

    const res = await as(s.admin).delete(`/api/returns/${ret.id}`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['paidInvoice']);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(7);
  });

  it('is refused once the restocked units are no longer free', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await dispatched(s);
    const ret = await restockedReturn(s);
    // 7 on the shelf, 6 of them since reserved for another shipment.
    await prisma.stockLevel.update({ where: { id: s.stock.id }, data: { reservedQuantity: 6 } });

    const res = await as(s.admin).delete(`/api/returns/${ret.id}`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking).toEqual([
      expect.objectContaining({ key: 'stockGone', count: 1 }),
    ]);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(7);
  });

  it('lets the shipment it blocked be deleted', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment } = await dispatched(s);
    const ret = await restockedReturn(s);
    expect((await as(s.admin).delete(`/api/shipments/${shipment.id}`)).status).toBe(409);

    expect((await as(s.admin).delete(`/api/returns/${ret.id}`)).status).toBe(200);
    const res = await as(s.admin).delete(`/api/shipments/${shipment.id}`);

    expect(res.status).toBe(200);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(10);
  });

  it('is closed to anyone without returns:delete', async () => {
    const s = await makeWarehouseScenario({
      permissions: ['returns:read', 'returns:create', 'returns:update'],
    });
    const recorded = await as(s.admin)
      .post('/api/returns')
      .send({ trackingNumber: 'T1', productId: s.product.id });

    expect((await as(s.employeeUser).get(`/api/returns/${recorded.body.id}/dependents`)).status).toBe(
      403,
    );
    expect((await as(s.employeeUser).delete(`/api/returns/${recorded.body.id}`)).status).toBe(403);
  });
});

describe('editing a return', () => {
  it('corrects the notes and nothing else', async () => {
    const s = await makeWarehouseScenario();
    const recorded = await as(s.admin)
      .post('/api/returns')
      .send({ trackingNumber: 'T1', productId: s.product.id, notes: 'box crushd' });

    const res = await as(s.admin)
      .patch(`/api/returns/${recorded.body.id}`)
      .send({ notes: 'Box crushed', quantity: 50 });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('Box crushed');
    expect(res.body.quantity).toBe(1);
  });

  it('has no disposition notes to correct before a decision', async () => {
    const s = await makeWarehouseScenario();
    const recorded = await as(s.admin)
      .post('/api/returns')
      .send({ trackingNumber: 'T1', productId: s.product.id });

    const res = await as(s.admin)
      .patch(`/api/returns/${recorded.body.id}`)
      .send({ dispositionNotes: 'Binned' });

    expect(res.status).toBe(400);
  });
});

describe("the line's Return button", () => {
  /** 5 dispatched with no tracking number at all — the line is the only link. */
  const dispatchedUntracked = async (s) => {
    const created = await as(s.admin)
      .post('/api/shipments')
      .send({
        shipmentItems: [{ productId: s.product.id, sourceLocationId: s.location.id, quantity: 5 }],
      });
    expect(created.status).toBe(201);
    const item = await prisma.shipmentItem.findFirst({ where: { shipmentId: created.body.id } });
    return { shipment: created.body, item };
  };

  it('books a restocked return record, linked to the line without a tracking number', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment, item } = await dispatchedUntracked(s);

    const res = await as(s.admin)
      .post(`/api/shipment-items/${item.id}/return`)
      .send({ quantity: 3, reason: 'Wrong size' });

    expect(res.status).toBe(200);
    expect(res.body.reference).toMatch(/^RET-\d{4}-\d{6}$/);
    const record = await prisma.productReturn.findUnique({ where: { id: res.body.id } });
    expect(record).toMatchObject({
      status: 'RESTOCKED',
      quantity: 3,
      shipmentId: shipment.id,
      shipmentItemId: item.id,
      restockLocationId: s.location.id,
      trackingNumber: null,
      notes: 'Wrong size',
    });
    expect(await onHandAt(s.product.id, s.location.id)).toBe(8);
  });

  it('links a charge it was asked for to the return', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.00', restock: '5.00' });
    const { item } = await dispatchedUntracked(s);

    const res = await as(s.admin)
      .post(`/api/shipment-items/${item.id}/return`)
      .send({ quantity: 3, chargeReturn: true });

    expect(res.body.returnCharge).toBe(3);
    // The handling rate only, as the button always charged — never a restock fee.
    const lines = await prisma.invoiceLineItem.findMany({ where: { returnId: res.body.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].itemType).toBe('MANUAL_CHARGE');
    expect(lines[0].shipmentId).toBeNull();
  });

  it('is undone by deleting the return, which then lets the shipment go', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    await giveRates(s.client.id, { handling: '1.00' });
    const { shipment, item } = await dispatchedUntracked(s);
    const returned = await as(s.admin)
      .post(`/api/shipment-items/${item.id}/return`)
      .send({ quantity: 3, chargeReturn: true });

    expect((await as(s.admin).delete(`/api/shipments/${shipment.id}`)).status).toBe(409);
    expect((await as(s.admin).delete(`/api/returns/${returned.body.id}`)).status).toBe(200);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(5);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(0);
    expect(await prisma.invoiceLineItem.count({ where: { itemType: 'MANUAL_CHARGE' } })).toBe(0);

    expect((await as(s.admin).delete(`/api/shipments/${shipment.id}`)).status).toBe(200);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(10);
  });

  it('leaves nothing for the old line-return undo to find', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment, item } = await dispatchedUntracked(s);
    await as(s.admin).post(`/api/shipment-items/${item.id}/return`).send({ quantity: 3 });

    expect((await as(s.admin).delete(`/api/shipments/${shipment.id}/line-returns`)).status).toBe(400);
  });
});

describe("undoing a shipment's old line returns", () => {
  /**
   * 3 back the way the line Return button booked them before it made records:
   * the line's count, the stock, and a charge linked to the shipment by the
   * migration. No return record.
   */
  const legacyLineReturn = async (s, shipment, item, { charge = true } = {}) => {
    await prisma.shipmentItem.update({
      where: { id: item.id },
      data: { returnedQuantity: { increment: 3 } },
    });
    await prisma.stockLevel.update({
      where: { id: s.stock.id },
      data: { currentQuantity: { increment: 3 } },
    });
    if (!charge) return null;
    const invoice =
      (await prisma.monthlyInvoice.findFirst({ where: { clientId: s.client.id } })) ??
      (await makeInvoice(s.client.id));
    return prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        itemType: 'MANUAL_CHARGE',
        shipmentId: shipment.id,
        description: `Return handling — 3 item(s) from shipment ${shipment.reference}`,
        quantity: 3,
        unitPrice: 1,
        totalPrice: 3,
        dateOfService: new Date(),
      },
    });
  };

  it('takes the units back off the shelf and the charge off, then lets the shipment go', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment, item } = await dispatched(s);
    await legacyLineReturn(s, shipment, item);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(8);

    const warning = await as(s.admin).get(`/api/shipments/${shipment.id}/line-returns/dependents`);
    expect(warning.body.canDelete).toBe(true);
    expect(Object.fromEntries(warning.body.removedWith.map((r) => [r.key, r.count]))).toMatchObject(
      { units: 3, charges: 1 },
    );

    const res = await as(s.admin).delete(`/api/shipments/${shipment.id}/line-returns`);

    expect(res.status).toBe(200);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(5);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(0);
    expect(
      await prisma.invoiceLineItem.count({
        where: { shipmentId: shipment.id, itemType: 'MANUAL_CHARGE' },
      }),
    ).toBe(0);

    expect((await as(s.admin).delete(`/api/shipments/${shipment.id}`)).status).toBe(200);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(10);
  });

  it('leaves return records alone', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment, item } = await dispatched(s);
    const ret = await restockedReturn(s);
    await legacyLineReturn(s, shipment, item, { charge: false });
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(5);

    const res = await as(s.admin).delete(`/api/shipments/${shipment.id}/line-returns`);

    expect(res.status).toBe(200);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(2);
    expect(await prisma.productReturn.findUnique({ where: { id: ret.id } })).not.toBeNull();
    // 10 - 5 out + 2 restocked + 3 line-returned - 3 undone.
    expect(await onHandAt(s.product.id, s.location.id)).toBe(7);
  });

  it('is refused while the return charge is on a paid invoice', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment, item } = await dispatched(s);
    const charge = await legacyLineReturn(s, shipment, item);
    await prisma.monthlyInvoice.update({ where: { id: charge.invoiceId }, data: { status: 'PAID' } });

    const res = await as(s.admin).delete(`/api/shipments/${shipment.id}/line-returns`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['paidInvoice']);
    expect(await onHandAt(s.product.id, s.location.id)).toBe(8);
  });

  it('says so when there is nothing to undo', async () => {
    const s = await makeWarehouseScenario({ quantity: 10 });
    const { shipment } = await dispatched(s);

    expect((await as(s.admin).delete(`/api/shipments/${shipment.id}/line-returns`)).status).toBe(400);
  });

  it('is closed to anyone without shipments:delete', async () => {
    const s = await makeWarehouseScenario({
      quantity: 10,
      permissions: ['shipments:read', 'shipments:update'],
    });
    const { shipment, item } = await dispatched(s);
    await legacyLineReturn(s, shipment, item, { charge: false });

    expect(
      (await as(s.employeeUser).delete(`/api/shipments/${shipment.id}/line-returns`)).status,
    ).toBe(403);
  });
});
