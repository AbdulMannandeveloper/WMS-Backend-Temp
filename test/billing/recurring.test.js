/**
 * Standing monthly charges.
 *
 * Before this, every invoice line was created at dispatch. A client who takes
 * storage, handling or a retainer but ships nothing through us therefore
 * generated no line at all — the "services only" arrangement had no automated
 * route to an invoice, and an admin had to retype a manual line every month.
 *
 * A ClientService marked recurring is raised for a period whether or not
 * anything moved. Application is idempotent, because it runs every time an open
 * invoice is resolved — which for a shipping client is once per dispatch.
 * Billing storage twice because two parcels went out would be worse than not
 * billing it at all.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import billingServices from '../../logic/billing_services.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeShipmentRate,
  makeRecurringService,
} from '../factories/index.js';

const { applyRecurringCharges } = billingServices;

const invoiceFor = (clientId) =>
  prisma.monthlyInvoice.findFirst({
    where: { clientId },
    include: { lineItems: true },
    orderBy: { billingPeriod: 'desc' },
  });

const openInvoice = (clientId, billingPeriod) =>
  prisma.monthlyInvoice.create({
    data: {
      clientId,
      billingPeriod: billingPeriod || new Date(Date.UTC(2026, 7, 1)),
      totalAmount: '0.00',
      status: 'DRAFT',
    },
  });

describe('applying standing charges', () => {
  it('raises a line for a recurring service', async () => {
    const { client } = await makeWarehouseScenario();
    await makeRecurringService(client.id, { chargedPrice: '25.00' });
    const invoice = await openInvoice(client.id);

    await applyRecurringCharges(client.id, invoice);

    const lines = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: invoice.id, itemType: 'RECURRING_SERVICE' },
    });
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].totalPrice)).toBe(25);
  });

  it('multiplies by the recurring quantity', async () => {
    // Four pallets of storage at 25.00 a pallet.
    const { client } = await makeWarehouseScenario();
    await makeRecurringService(client.id, {
      chargedPrice: '25.00',
      recurringQuantity: '4',
    });
    const invoice = await openInvoice(client.id);

    await applyRecurringCharges(client.id, invoice);

    const line = await prisma.invoiceLineItem.findFirst({
      where: { invoiceId: invoice.id, itemType: 'RECURRING_SERVICE' },
    });
    expect(Number(line.quantity)).toBe(4);
    expect(Number(line.totalPrice)).toBe(100);
  });

  it('does not bill the same service twice on one invoice', async () => {
    // The guarantee that makes it safe to call on every dispatch.
    const { client } = await makeWarehouseScenario();
    await makeRecurringService(client.id);
    const invoice = await openInvoice(client.id);

    await applyRecurringCharges(client.id, invoice);
    await applyRecurringCharges(client.id, invoice);
    await applyRecurringCharges(client.id, invoice);

    const lines = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: invoice.id, itemType: 'RECURRING_SERVICE' },
    });
    expect(lines).toHaveLength(1);
  });

  it('bills the same service again on the next period', async () => {
    // Idempotency is per invoice, not for all time — it is a monthly charge.
    const { client } = await makeWarehouseScenario();
    await makeRecurringService(client.id);

    const august = await openInvoice(client.id, new Date(Date.UTC(2026, 7, 1)));
    const september = await openInvoice(client.id, new Date(Date.UTC(2026, 8, 1)));

    await applyRecurringCharges(client.id, august);
    await applyRecurringCharges(client.id, september);

    expect(
      await prisma.invoiceLineItem.count({ where: { itemType: 'RECURRING_SERVICE' } })
    ).toBe(2);
  });

  it('ignores services that are not marked recurring', async () => {
    const { client } = await makeWarehouseScenario();
    await makeShipmentRate(client.id, '2.00'); // an ordinary, non-recurring rate
    const invoice = await openInvoice(client.id);

    await applyRecurringCharges(client.id, invoice);

    expect(
      await prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } })
    ).toBe(0);
  });

  it('dates the line to the period it covers, not to today', async () => {
    // A charge raised late still belongs to the month it is for.
    const { client } = await makeWarehouseScenario();
    await makeRecurringService(client.id);
    const invoice = await openInvoice(client.id, new Date(Date.UTC(2026, 7, 1)));

    await applyRecurringCharges(client.id, invoice);

    const line = await prisma.invoiceLineItem.findFirst({
      where: { invoiceId: invoice.id },
    });
    expect(line.dateOfService.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  it('raises every recurring service the client holds', async () => {
    const { client } = await makeWarehouseScenario();
    await makeRecurringService(client.id, { chargedPrice: '25.00' });
    await makeRecurringService(client.id, { chargedPrice: '40.00' });
    const invoice = await openInvoice(client.id);

    await applyRecurringCharges(client.id, invoice);

    const lines = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(lines).toHaveLength(2);
  });

  it('does not touch another client', async () => {
    const a = await makeWarehouseScenario();
    const b = await makeWarehouseScenario();
    await makeRecurringService(b.client.id);
    const invoice = await openInvoice(a.client.id);

    await applyRecurringCharges(a.client.id, invoice);

    expect(
      await prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } })
    ).toBe(0);
  });
});

describe('the three billing arrangements', () => {
  /** A shipment ready to go, carrying `units`. */
  const readyShipment = async (scenario, units = 10) => {
    const { employee, client, product, location, stock } = scenario;
    const shipment = await makeShipment(employee.id, client.id, {
      status: 'READY_FOR_DISPATCH',
    });
    await makeShipmentItem(shipment.id, product.id, location.id, {
      quantity: units,
      status: 'PICKED',
    });
    const current = await prisma.stockLevel.findUnique({ where: { id: stock.id } });
    await prisma.stockLevel.update({
      where: { id: stock.id },
      data: { reservedQuantity: current.reservedQuantity + units },
    });
    return shipment;
  };

  it('shipment only — billed per item, nothing else', async () => {
    const scenario = await makeWarehouseScenario({ quantity: 100 });
    await makeShipmentRate(scenario.client.id, '2.00');
    const shipment = await readyShipment(scenario, 10);

    await as(scenario.admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(scenario.client.id);
    expect(invoice.lineItems).toHaveLength(1);
    expect(Number(invoice.totalAmount)).toBe(20);
  });

  it('services only — billed with no shipment at all', async () => {
    // The arrangement that previously produced nothing. There is no shipment
    // here and no dispatch: the charge has to arrive on its own.
    const scenario = await makeWarehouseScenario();
    await makeRecurringService(scenario.client.id, { chargedPrice: '25.00' });
    const invoice = await openInvoice(scenario.client.id);

    await applyRecurringCharges(scenario.client.id, invoice);

    const after = await invoiceFor(scenario.client.id);
    expect(after.lineItems).toHaveLength(1);
    expect(after.lineItems[0].itemType).toBe('RECURRING_SERVICE');
  });

  it('both — the standing charge and the per-item charge on one invoice', async () => {
    const scenario = await makeWarehouseScenario({ quantity: 100 });
    await makeShipmentRate(scenario.client.id, '2.00');
    await makeRecurringService(scenario.client.id, { chargedPrice: '25.00' });
    const shipment = await readyShipment(scenario, 10);

    await as(scenario.admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoice = await invoiceFor(scenario.client.id);
    const byType = Object.fromEntries(
      invoice.lineItems.map((l) => [l.itemType, Number(l.totalPrice)])
    );

    expect(byType.SHIPMENT_CHARGE).toBe(20); // 10 items x 2.00
    expect(byType.RECURRING_SERVICE).toBe(25);
    expect(Number(invoice.totalAmount)).toBe(45);
  });

  it('a dispatch does not re-bill the standing charge', async () => {
    // Two parcels in a month must not bill storage twice.
    const scenario = await makeWarehouseScenario({ quantity: 100 });
    await makeShipmentRate(scenario.client.id, '2.00');
    await makeRecurringService(scenario.client.id, { chargedPrice: '25.00' });

    const first = await readyShipment(scenario, 5);
    await as(scenario.admin).post(`/api/shipments/${first.id}/dispatch`);
    const second = await readyShipment(scenario, 5);
    await as(scenario.admin).post(`/api/shipments/${second.id}/dispatch`);

    const invoice = await invoiceFor(scenario.client.id);
    const recurring = invoice.lineItems.filter(
      (l) => l.itemType === 'RECURRING_SERVICE'
    );

    expect(recurring).toHaveLength(1);
    expect(Number(invoice.totalAmount)).toBe(45); // 25 + (5x2) + (5x2)
  });
});
