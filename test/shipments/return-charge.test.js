/**
 * What a return costs.
 *
 * The rule that must not bend: **the shipment's own charge never changes**. What
 * was dispatched was dispatched, and rewriting a line already raised is how an
 * invoice stops matching what the client was told. A return fee, when there is
 * one, is a separate line sitting beside it.
 *
 * It is optional twice over. A client with no agreed ITEM_RETURN rate is never
 * charged, and even with one the admin decides per return — the box starts
 * unticked, because forgetting to untick would bill for a return meant to be
 * absorbed, and an unnoticed charge is worse than an unnoticed omission.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipmentRate,
  makeService,
  makeClientService,
} from '../factories/index.js';
import billingServices from '../../logic/billing_services.js';

const { RETURN_SERVICE_CODE, ensureReturnService } = billingServices;

/** A dispatched shipment of 5, with a dispatch rate so it carries a charge. */
const arrangeDispatched = async ({ returnRate = null } = {}) => {
  const s = await makeWarehouseScenario({ quantity: 50 });
  await makeShipmentRate(s.client.id, '2.00');

  if (returnRate !== null) {
    const service = await ensureReturnService();
    await makeClientService(s.client.id, service.id, {
      chargedPrice: returnRate,
      unit: 'item',
    });
  }

  const created = await as(s.admin)
    .post('/api/shipments')
    .send({
      reference: `SHP-${Math.random().toString(36).slice(2, 10)}`,
      shipmentItems: [
        { productId: s.product.id, sourceLocationId: s.location.id, quantity: 5 },
      ],
    });

  const item = await prisma.shipmentItem.findFirst({
    where: { shipmentId: created.body.id },
  });

  return { ...s, shipment: created.body, item };
};

const dispatchLine = (clientId) =>
  prisma.invoiceLineItem.findFirst({
    where: { itemType: 'SHIPMENT_CHARGE', invoice: { clientId } },
  });

const returnItem = (actor, itemId, body) =>
  as(actor).post(`/api/shipment-items/${itemId}/return`).send(body);

const onHand = async (productId) => {
  const { _sum } = await prisma.stockLevel.aggregate({
    where: { productId },
    _sum: { currentQuantity: true },
  });
  return _sum.currentQuantity ?? 0;
};

describe('the shipment charge is never rewritten', () => {
  it('stays exactly as raised when items come back', async () => {
    const s = await arrangeDispatched();
    const before = await dispatchLine(s.client.id);

    await returnItem(s.admin, s.item.id, { quantity: 2, reason: 'Damaged' });

    const after = await dispatchLine(s.client.id);
    expect(Number(after.quantity)).toBe(Number(before.quantity));
    expect(Number(after.totalPrice)).toBe(Number(before.totalPrice));
  });

  it('stays as raised even when the return itself is charged', async () => {
    const s = await arrangeDispatched({ returnRate: '1.50' });
    const before = await dispatchLine(s.client.id);

    await returnItem(s.admin, s.item.id, { quantity: 2, chargeReturn: true });

    const after = await dispatchLine(s.client.id);
    expect(Number(after.totalPrice)).toBe(Number(before.totalPrice));
  });
});

describe('the stock comes back regardless', () => {
  it('goes back on the shelf when nothing is charged', async () => {
    const s = await arrangeDispatched();
    const before = await onHand(s.product.id);

    await returnItem(s.admin, s.item.id, { quantity: 2 });

    expect(await onHand(s.product.id)).toBe(before + 2);
  });

  it('goes back on the shelf when the return is charged', async () => {
    const s = await arrangeDispatched({ returnRate: '1.50' });
    const before = await onHand(s.product.id);

    await returnItem(s.admin, s.item.id, { quantity: 2, chargeReturn: true });

    expect(await onHand(s.product.id)).toBe(before + 2);
  });
});

describe('charging the return', () => {
  it('does not charge unless asked', async () => {
    // The client has a rate. It still must not be billed by default.
    const s = await arrangeDispatched({ returnRate: '1.50' });

    await returnItem(s.admin, s.item.id, { quantity: 2 });

    const charge = await prisma.invoiceLineItem.findFirst({
      where: { description: { contains: 'Return handling' } },
    });
    expect(charge).toBeNull();
  });

  it('charges quantity times the agreed rate when asked', async () => {
    const s = await arrangeDispatched({ returnRate: '1.50' });

    const res = await returnItem(s.admin, s.item.id, { quantity: 2, chargeReturn: true });

    expect(res.status).toBe(200);
    const charge = await prisma.invoiceLineItem.findFirst({
      where: { description: { contains: 'Return handling' } },
    });
    expect(Number(charge.totalPrice)).toBe(3);
    expect(Number(charge.quantity)).toBe(2);
  });

  it('never charges a client with no agreed return rate, even when asked', async () => {
    const s = await arrangeDispatched();

    const res = await returnItem(s.admin, s.item.id, { quantity: 2, chargeReturn: true });

    expect(res.status).toBe(200);
    expect(res.body.returnCharge).toBeNull();
    expect(
      await prisma.invoiceLineItem.count({
        where: { description: { contains: 'Return handling' } },
      }),
    ).toBe(0);
  });

  it('treats anything other than true as no', async () => {
    // "false", 0 and null all arrive over JSON. The safe reading of an unclear
    // request about money is the one that bills nobody.
    const s = await arrangeDispatched({ returnRate: '1.50' });

    await returnItem(s.admin, s.item.id, { quantity: 1, chargeReturn: 'false' });
    await returnItem(s.admin, s.item.id, { quantity: 1, chargeReturn: 0 });
    await returnItem(s.admin, s.item.id, { quantity: 1, chargeReturn: null });

    expect(
      await prisma.invoiceLineItem.count({
        where: { description: { contains: 'Return handling' } },
      }),
    ).toBe(0);
  });

  it('names the shipment label on the charge', async () => {
    const s = await arrangeDispatched({ returnRate: '1.50' });

    await returnItem(s.admin, s.item.id, { quantity: 1, chargeReturn: true });

    const charge = await prisma.invoiceLineItem.findFirst({
      where: { description: { contains: 'Return handling' } },
    });
    expect(charge.description).toContain(s.shipment.reference);
  });
});

describe('what cannot be returned', () => {
  it('refuses more than was sent', async () => {
    const s = await arrangeDispatched();

    const res = await returnItem(s.admin, s.item.id, { quantity: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only 5|only was 5|only \d+/i);
  });

  it('counts what has already come back', async () => {
    const s = await arrangeDispatched();
    await returnItem(s.admin, s.item.id, { quantity: 3 });

    const res = await returnItem(s.admin, s.item.id, { quantity: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been returned/i);
  });

  it('refuses a quantity of zero', async () => {
    const s = await arrangeDispatched();

    const res = await returnItem(s.admin, s.item.id, { quantity: 0 });
    expect(res.status).toBe(400);
  });
});

describe('the return service itself', () => {
  it('is seeded and priced per item', async () => {
    const service = await ensureReturnService();

    expect(service.code).toBe(RETURN_SERVICE_CODE);
    expect(service.unit).toBe('item');
  });

  it('is idempotent, because every worker seeds it on boot', async () => {
    await ensureReturnService();
    await ensureReturnService();

    expect(
      await prisma.service.count({ where: { code: RETURN_SERVICE_CODE } }),
    ).toBe(1);
  });

  it('is distinct from the dispatch and FBA services', async () => {
    await ensureReturnService();
    const codes = (await prisma.service.findMany({ select: { code: true } }))
      .map((s) => s.code)
      .filter(Boolean);

    expect(new Set(codes).size).toBe(codes.length);
  });
});
