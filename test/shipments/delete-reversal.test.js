/**
 * Deleting a dispatched shipment, and putting everything back.
 *
 * A dispatched shipment moved two things that a delete now has to unwind: the
 * goods came off the shelf (a CHECKOUT ledger entry) and the client was billed
 * (a SHIPMENT_CHARGE line). Deleting was refused for exactly that reason. It is
 * allowed now, and this file pins what "reverse it" means:
 *
 *   - every unit still out goes back to its source bin, via a RETURN movement,
 *   - the shipment's invoice line is removed and the total recomputed,
 *   - and none of it happens once the invoice has been paid, because money that
 *     has changed hands is unwound with a credit note, not by deleting the
 *     record of what it paid for.
 *
 * A real dispatch is built through the API (create == dispatch) rather than by
 * writing a DISPATCHED row directly, so the stock and the charge under test are
 * the ones the system actually produced.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeWarehouseScenario, makeShipmentRate } from '../factories/index.js';

let scenario;

/** Dispatch `quantity` of the scenario's product at £`price`/item, through the API. */
const dispatch = async (quantity = 10, price = '2.00') => {
  await makeShipmentRate(scenario.client.id, price);

  const res = await as(scenario.admin)
    .post('/api/shipments')
    .send({
      shipmentItems: [
        {
          productId: scenario.product.id,
          sourceLocationId: scenario.location.id,
          quantity,
        },
      ],
    });

  expect(res.status).toBe(201);
  return res.body;
};

const onHand = async () => {
  const stock = await prisma.stockLevel.findUnique({ where: { id: scenario.stock.id } });
  return stock.currentQuantity;
};

const chargeLineFor = (shipmentId) =>
  prisma.invoiceLineItem.findFirst({
    where: { shipmentId, itemType: 'SHIPMENT_CHARGE' },
    include: { invoice: true },
  });

beforeEach(async () => {
  scenario = await makeWarehouseScenario({ quantity: 100 });
});

describe('deleting a dispatched shipment', () => {
  it('puts every unit back on the shelf', async () => {
    const shipment = await dispatch(10);
    expect(await onHand()).toBe(90); // dispatch took 10

    const res = await as(scenario.admin).delete(`/api/shipments/${shipment.id}`);

    expect(res.status).toBe(200);
    expect(await onHand()).toBe(100);
    await expect(
      prisma.shipment.count({ where: { id: shipment.id } }),
    ).resolves.toBe(0);
  });

  it('writes the restoration as a RETURN movement against the same reference', async () => {
    const shipment = await dispatch(10);

    await as(scenario.admin).delete(`/api/shipments/${shipment.id}`);

    const returns = await prisma.inventoryLedger.findMany({
      where: { referenceId: shipment.reference, movementType: 'RETURN' },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0].quantity).toBe(10);
    // The CHECKOUT it reverses shares the reference, so the pair survives the
    // deleted row and reads as matched history.
    const checkouts = await prisma.inventoryLedger.count({
      where: { referenceId: shipment.reference, movementType: 'CHECKOUT' },
    });
    expect(checkouts).toBe(1);
  });

  it('removes the invoice charge and recomputes the total', async () => {
    const shipment = await dispatch(10, '2.00');

    const before = await chargeLineFor(shipment.id);
    expect(before).not.toBeNull();
    expect(Number(before.totalPrice)).toBe(20); // 10 × 2.00
    const invoiceId = before.invoiceId;

    await as(scenario.admin).delete(`/api/shipments/${shipment.id}`);

    await expect(chargeLineFor(shipment.id)).resolves.toBeNull();
    const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: invoiceId } });
    expect(Number(invoice.totalAmount)).toBe(0);
  });

  it('refuses while part of it has come back, and changes nothing', async () => {
    // A return is proof the parcel went out, and may carry charges of its own.
    // Deleting the shipment under it used to take the dispatch charge off and
    // put the remainder back, leaving the return behind and unlinked. Returns
    // are dealt with first now.
    const shipment = await dispatch(10);
    const item = (
      await prisma.shipmentItem.findMany({ where: { shipmentId: shipment.id } })
    )[0];

    // Return 3 of the 10 first; the shelf is now 90 + 3 = 93.
    await as(scenario.admin)
      .post(`/api/shipment-items/${item.id}/return`)
      .send({ quantity: 3 });
    expect(await onHand()).toBe(93);

    const res = await as(scenario.admin).delete(`/api/shipments/${shipment.id}`);

    expect(res.status).toBe(409);
    expect(res.body.dependents.blocking).toEqual([
      expect.objectContaining({ key: 'lineReturns', count: 3 }),
    ]);
    expect(await onHand()).toBe(93);
    await expect(prisma.shipment.count({ where: { id: shipment.id } })).resolves.toBe(1);
    await expect(chargeLineFor(shipment.id)).resolves.not.toBeNull();
  });

  it('refuses even when the whole line came back', async () => {
    const shipment = await dispatch(10);
    const item = (
      await prisma.shipmentItem.findMany({ where: { shipmentId: shipment.id } })
    )[0];
    await as(scenario.admin)
      .post(`/api/shipment-items/${item.id}/return`)
      .send({ quantity: 10 });
    expect(await onHand()).toBe(100);

    const res = await as(scenario.admin).delete(`/api/shipments/${shipment.id}`);

    expect(res.status).toBe(409);
    expect(await onHand()).toBe(100);
  });
});

describe('once the invoice has been paid', () => {
  it('refuses the delete and changes nothing', async () => {
    const shipment = await dispatch(10, '2.00');
    const charge = await chargeLineFor(shipment.id);

    await prisma.monthlyInvoice.update({
      where: { id: charge.invoiceId },
      data: { status: 'PAID', paidAt: new Date() },
    });

    const res = await as(scenario.admin).delete(`/api/shipments/${shipment.id}`);

    // A refusal with the reason attached, which the delete dialog lists.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/paid/i);
    expect(res.body.dependents.blocking.map((r) => r.key)).toEqual(['paidInvoice']);
    // Everything intact: the row, the stock, the charge.
    await expect(
      prisma.shipment.count({ where: { id: shipment.id } }),
    ).resolves.toBe(1);
    expect(await onHand()).toBe(90);
    await expect(chargeLineFor(shipment.id)).resolves.not.toBeNull();
  });
});

describe('a shipment that was never billed', () => {
  it('still deletes and restores stock when the client had no rate', async () => {
    // No makeShipmentRate — dispatch raises no charge for a rate-less client.
    const res = await as(scenario.admin)
      .post('/api/shipments')
      .send({
        shipmentItems: [
          {
            productId: scenario.product.id,
            sourceLocationId: scenario.location.id,
            quantity: 5,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(await onHand()).toBe(95);

    const del = await as(scenario.admin).delete(`/api/shipments/${res.body.id}`);

    expect(del.status).toBe(200);
    expect(await onHand()).toBe(100);
  });
});
