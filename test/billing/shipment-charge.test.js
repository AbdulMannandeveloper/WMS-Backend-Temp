/**
 * The dispatch charge — per item shipped, priced from the rate card.
 *
 * Two rewrites deep now, and the second one mattered more than the first.
 *
 * Chunk 2.1 connected Client.fixedShipmentRate to LineItemType.SHIPMENT_CHARGE,
 * which had both been declared and referenced nowhere. But that column could not
 * be written by anything in the application — not the update allowlist, not any
 * route, not the UI — so every client held its 0.00 default and the charge was
 * never actually raised for anyone in production. These tests passed only
 * because they set the column directly through Prisma.
 *
 * It is a catalogue Service now, priced per client through the same
 * ClientService rate card as everything else, and billed by the number of items
 * shipped rather than a flat 1 per dispatch. A five-hundred-item shipment used
 * to bill the same as a single-item one.
 *
 * The rate is still read at dispatch and frozen onto the line, so a later rate
 * change cannot rewrite a charge already raised.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeService,
  makeClientService,
  makeShipmentRate,
} from '../factories/index.js';

/** A ready-to-dispatch shipment for a client on `rate`, optionally with a service. */
const arrange = async ({ rate = '5.00', withService = null } = {}) => {
  const scenario = await makeWarehouseScenario({ quantity: 100 });
  const { employee, client, product, location, stock } = scenario;

  if (rate !== null) {
    await makeShipmentRate(client.id, rate);
  }

  const shipment = await makeShipment(employee.id, client.id, {
    status: 'READY_FOR_DISPATCH',
  });
  await makeShipmentItem(shipment.id, product.id, location.id, {
    quantity: 10,
    status: 'PICKED',
  });
  await prisma.stockLevel.update({
    where: { id: stock.id },
    data: { reservedQuantity: 10 },
  });

  if (withService) {
    const service = await makeService({ description: 'Pallet wrapping' });
    await makeClientService(client.id, service.id, {
      chargedPrice: withService.chargedPrice,
    });
    await prisma.shipmentServiceMapping.create({
      data: {
        shipmentId: shipment.id,
        serviceId: service.id,
        quantity: withService.quantity,
        appliedUnitPrice: withService.chargedPrice,
      },
    });
  }

  return { ...scenario, shipment };
};

const invoiceFor = (clientId) =>
  prisma.monthlyInvoice.findFirst({
    where: { clientId },
    include: { lineItems: true },
  });

describe('shipment charge', () => {
  it('bills per item shipped, not once per shipment', async () => {
    const { admin, shipment, client } = await arrange({ rate: '12.50' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const charges = invoice.lineItems.filter((l) => l.itemType === 'SHIPMENT_CHARGE');

    // The fixture ships 10 units. Flat charging billed 12.50 for all of them.
    expect(charges).toHaveLength(1);
    expect(Number(charges[0].quantity)).toBe(10);
    expect(Number(charges[0].unitPrice)).toBe(12.5);
    expect(Number(charges[0].totalPrice)).toBe(125);
  });

  it('counts units, not lines — twenty of one SKU is twenty items', async () => {
    const { admin, shipment, client, product, location, stock } = await arrange({
      rate: '1.00',
    });
    // A second line, so the shipment is 2 lines but 10 + 15 = 25 units.
    await makeShipmentItem(shipment.id, product.id, location.id, {
      quantity: 15,
      status: 'PICKED',
    });
    await prisma.stockLevel.update({
      where: { id: stock.id },
      data: { reservedQuantity: 25 },
    });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(Number(charge.quantity)).toBe(25);
    expect(Number(charge.totalPrice)).toBe(25);
  });

  it('points the line at the agreed rate it came from', async () => {
    // Flat charging wrote clientServiceId: null, so a shipment charge could not
    // be traced back to a rate the client had agreed to.
    const { admin, shipment, client } = await arrange({ rate: '2.00' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(charge.clientServiceId).not.toBeNull();
  });

  it('names the shipment on the line so an invoice reader can trace it', async () => {
    const { admin, shipment, client } = await arrange({ rate: '12.50' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(charge.description).toContain(shipment.id);
    expect(charge.description).toContain('Evri');
    // The count is on the line too, so an invoice explains its own arithmetic.
    expect(charge.description).toContain('10 item');
  });

  it('charges nothing, and opens no invoice, when the client has no dispatch rate', async () => {
    // A services-only client: stored and handled here, shipped by someone else.
    const { admin, shipment, client } = await arrange({ rate: null });

    const res = await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    // The goods still move; there is simply nothing to bill.
    expect(res.status).toBe(200);
    await expect(
      prisma.monthlyInvoice.count({ where: { clientId: client.id } })
    ).resolves.toBe(0);
  });

  it('bills the rate alongside mapped services, and the total agrees', async () => {
    const { admin, shipment, client } = await arrange({
      rate: '10.00',
      withService: { chargedPrice: '3.00', quantity: 4 },
    });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const byType = Object.fromEntries(
      invoice.lineItems.map((l) => [l.itemType, Number(l.totalPrice)])
    );

    expect(byType.SHIPMENT_CHARGE).toBe(100); // 10 items x 10.00
    expect(byType.AUTOMATED_SERVICE).toBe(12); // 4 x 3.00
    // 1.1's invariant, holding across the dispatch path.
    expect(Number(invoice.totalAmount)).toBe(112);
  });

  it('does not rewrite a raised charge when the rate later changes', async () => {
    const { admin, shipment, client } = await arrange({ rate: '10.00' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    await prisma.clientService.updateMany({
      where: { clientId: client.id },
      data: { chargedPrice: '99.00' },
    });

    const invoice = await invoiceFor(client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');

    // 10 units at the 10.00 rate frozen at dispatch, not the 99.00 set after.
    expect(Number(charge.totalPrice)).toBe(100);
    expect(Number(invoice.totalAmount)).toBe(100);
  });

  it('bills each dispatch separately onto the one monthly invoice', async () => {
    const { admin, employee, client, product, location, stock } = await arrange({
      rate: '7.00',
    });

    // A second shipment for the same client, same month.
    const second = await makeShipment(employee.id, client.id, {
      status: 'READY_FOR_DISPATCH',
    });
    await makeShipmentItem(second.id, product.id, location.id, {
      quantity: 5,
      status: 'PICKED',
    });
    await prisma.stockLevel.update({
      where: { id: stock.id },
      data: { reservedQuantity: 15 },
    });

    const first = await prisma.shipment.findFirst({
      where: { clientId: client.id, id: { not: second.id } },
    });

    await as(admin).post(`/api/shipments/${first.id}/dispatch`);
    await as(admin).post(`/api/shipments/${second.id}/dispatch`);

    const invoices = await prisma.monthlyInvoice.findMany({
      where: { clientId: client.id },
      include: { lineItems: true },
    });

    expect(invoices).toHaveLength(1);
    expect(invoices[0].lineItems).toHaveLength(2);
    // 10 items and 5 items, both at 7.00: two lines that price themselves.
    expect(Number(invoices[0].totalAmount)).toBe(105);
  });
});
