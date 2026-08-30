/**
 * Billing periods are UTC calendar months.
 *
 * `billing_period`, `month_year` and the P&L period are all `@db.Date` columns,
 * which Prisma stores from the Date's UTC calendar day. Building a month
 * boundary with local-time constructors therefore files the row under the
 * previous month anywhere east of UTC:
 *
 *     new Date(2026, 7, 1)   // UTC+5 -> 2026-07-31T19:00Z -> stored 2026-07-31
 *
 * That was the state of the invoice, payroll and P&L paths. Dispatch was changed
 * to UTC in chunk 1.3, which made the two conventions disagree — an invoice
 * created through the API and one opened by dispatch landed on different rows
 * for the same month, and the unique constraint on (client, billing_period)
 * could not catch it because the dates genuinely differed.
 *
 * Chunk 2.1 moved every site onto utils/dates.js. These tests hold that line.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeService,
  makeClientService,
  makeShipmentRate,
} from '../factories/index.js';

const thisMonthUtc = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
};

const iso = (d) => new Date(d).toISOString().slice(0, 10);

describe('billing periods', () => {
  it("stores the 1st of the month, not the previous month's last day", async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    const res = await as(admin)
      .post('/api/monthly-invoices')
      .send({ clientId: client.id });

    expect(res.status).toBe(201);

    const invoice = await prisma.monthlyInvoice.findFirst({
      where: { clientId: client.id },
    });

    expect(iso(invoice.billingPeriod)).toBe(iso(thisMonthUtc()));
    // The failure mode this guards against: a day-of-month that is not the 1st.
    expect(new Date(invoice.billingPeriod).getUTCDate()).toBe(1);
  });

  it('the API and dispatch resolve to the SAME invoice, not two', async () => {
    // The regression. Before 2.1 the API wrote 2026-07-31 and dispatch wrote
    // 2026-08-01, so a client ended up with two invoices for one month.
    const scenario = await makeWarehouseScenario();
    const { admin, employee, client, product, location, stock } = scenario;

    // 1. An invoice opened through the API for the current month.
    const created = await as(admin)
      .post('/api/monthly-invoices')
      .send({ clientId: client.id });
    expect(created.status).toBe(201);

    // 2. A shipment carrying a billable service, dispatched. The dispatch rate
    // is set up explicitly — it used to come from a factory default on a Client
    // column that no longer exists, which made this test depend on something it
    // never mentioned.
    await makeShipmentRate(client.id, '5.00');
    const service = await makeService({ description: 'Wrapping' });
    await makeClientService(client.id, service.id, { chargedPrice: '5.00' });

    const shipment = await makeShipment(employee.id, client.id, {
      status: 'READY_FOR_DISPATCH',
    });
    await makeShipmentItem(shipment.id, product.id, location.id, {
      quantity: 5,
      status: 'PICKED',
    });
    await prisma.stockLevel.update({
      where: { id: stock.id },
      data: { reservedQuantity: 5 },
    });
    await prisma.shipmentServiceMapping.create({
      data: {
        shipmentId: shipment.id,
        serviceId: service.id,
        quantity: 1,
        appliedUnitPrice: '5.00',
      },
    });

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoices = await prisma.monthlyInvoice.findMany({
      where: { clientId: client.id },
      include: { lineItems: true },
    });

    // One invoice, and it is the one the API opened — not a second row filed
    // under a neighbouring day.
    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe(created.body.id);

    // It carries both charges dispatch raises: the per-item shipment charge and
    // the mapped service.
    expect(invoices[0].lineItems.map((l) => l.itemType).sort()).toEqual([
      'AUTOMATED_SERVICE',
      'SHIPMENT_CHARGE',
    ]);
  });

  it('payroll files against the same month boundary', async () => {
    const payrollLogic = await import('../../logic/payroll.logic.js');
    const { makeEmployee } = await import('../factories/index.js');
    const { user } = await makeEmployee({ baseSalary: '1000.00' });
    const admin = await makeAdmin();

    await payrollLogic.default.finalizePayroll(new Date(), admin.id);

    const record = await prisma.payrollRecord.findFirst({ where: { userId: user.id } });
    expect(iso(record.monthYear)).toBe(iso(thisMonthUtc()));
    expect(new Date(record.monthYear).getUTCDate()).toBe(1);
  });

  it('the P&L period matches the invoices raised in that month', async () => {
    const admin = await makeAdmin();
    const { client } = await makeClient();

    const invoice = await prisma.monthlyInvoice.create({
      data: {
        clientId: client.id,
        billingPeriod: thisMonthUtc(),
        totalAmount: '250.00',
        status: 'APPROVED',
      },
    });
    expect(invoice.id).toBeTruthy();

    const res = await as(admin).get('/api/profit-loss/summary');

    expect(res.status).toBe(200);
    // A local-time normalizeMonth would query a different day and find nothing.
    expect(res.body.totalEarnings).toBe(250);
    expect(iso(res.body.monthYear)).toBe(iso(thisMonthUtc()));
  });
});
