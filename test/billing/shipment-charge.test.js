/**
 * The per-shipment charge.
 *
 * `Client.fixedShipmentRate` and `LineItemType.SHIPMENT_CHARGE` were both
 * declared in the schema and referenced nowhere, so a dispatched shipment billed
 * only its mapped services — and a client with no services was never charged for
 * shipping at all. Chunk 2.1 connects them.
 *
 * The rate is read at dispatch and written onto the line, so a later rate change
 * cannot rewrite a charge already raised.
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
} from '../factories/index.js';

/** A ready-to-dispatch shipment for a client on `rate`, optionally with a service. */
const arrange = async ({ rate = '5.00', withService = null } = {}) => {
  const scenario = await makeWarehouseScenario({ quantity: 100 });
  const { employee, client, product, location, stock } = scenario;

  await prisma.client.update({
    where: { id: client.id },
    data: { fixedShipmentRate: rate },
  });

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
  it('raises one SHIPMENT_CHARGE at the client rate', async () => {
    const { admin, shipment, client } = await arrange({ rate: '12.50' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const charges = invoice.lineItems.filter((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(charges).toHaveLength(1);
    expect(Number(charges[0].quantity)).toBe(1);
    expect(Number(charges[0].unitPrice)).toBe(12.5);
    expect(Number(charges[0].totalPrice)).toBe(12.5);
  });

  it('names the shipment on the line so an invoice reader can trace it', async () => {
    const { admin, shipment, client } = await arrange({ rate: '12.50' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(charge.description).toContain(shipment.id);
    expect(charge.description).toContain('Evri');
  });

  it('charges nothing, and opens no invoice, when the rate is zero', async () => {
    const { admin, shipment, client } = await arrange({ rate: '0.00' });

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

    expect(byType.SHIPMENT_CHARGE).toBe(10);
    expect(byType.AUTOMATED_SERVICE).toBe(12); // 4 x 3.00
    // 1.1's invariant, holding across the dispatch path.
    expect(Number(invoice.totalAmount)).toBe(22);
  });

  it('does not rewrite a raised charge when the rate later changes', async () => {
    const { admin, shipment, client } = await arrange({ rate: '10.00' });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    await prisma.client.update({
      where: { id: client.id },
      data: { fixedShipmentRate: '99.00' },
    });

    const invoice = await invoiceFor(client.id);
    const charge = invoice.lineItems.find((l) => l.itemType === 'SHIPMENT_CHARGE');

    expect(Number(charge.totalPrice)).toBe(10);
    expect(Number(invoice.totalAmount)).toBe(10);
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
    expect(Number(invoices[0].totalAmount)).toBe(14);
  });
});
