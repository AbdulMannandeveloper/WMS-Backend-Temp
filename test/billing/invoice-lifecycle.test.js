/**
 * The invoice lifecycle: DRAFT → APPROVED → PAID.
 *
 * Before chunk 2.2 the API enforced almost none of it. Line items could be added
 * to or removed from an invoice the client had already approved, an approved
 * invoice could be deleted outright, and nothing ever reached PAID — the enum
 * member existed and no code path set it, so the P&L counted approved and paid
 * revenue identically and there was no record of when money arrived.
 *
 * The admin UI had been gating line-item editing on DRAFT all along. As with the
 * shipment state machine in 1.2, the rule lived only in the browser.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeShipmentRate,
  makeAdmin,
  makeClient,
  makeInvoice,
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeService,
  makeClientService,
} from '../factories/index.js';

/** An invoice carrying one £50 line, at whatever status is asked for. */
const arrange = async (status = 'DRAFT') => {
  const admin = await makeAdmin();
  const { client } = await makeClient();
  const invoice = await makeInvoice(client.id);

  const line = await as(admin)
    .post(`/api/monthly-invoices/${invoice.id}/line-items`)
    .send({
      description: 'Pallet handling',
      quantity: 1,
      unitPrice: 50,
      dateOfService: new Date().toISOString(),
    });

  if (status !== 'DRAFT') {
    await prisma.monthlyInvoice.update({
      where: { id: invoice.id },
      data: { status },
    });
  }

  return { admin, client, invoice, lineId: line.body.id };
};

const statusOf = async (id) =>
  (await prisma.monthlyInvoice.findUnique({ where: { id } })).status;

describe('invoice lifecycle', () => {
  describe('editing is DRAFT-only', () => {
    it('a draft still accepts line items', async () => {
      const { admin, invoice } = await arrange('DRAFT');

      const res = await as(admin)
        .post(`/api/monthly-invoices/${invoice.id}/line-items`)
        .send({ description: 'Extra', quantity: 1, unitPrice: 10 });

      expect(res.status).toBe(201);
    });

    for (const status of ['APPROVED', 'PAID']) {
      it(`an ${status} invoice refuses a new line item`, async () => {
        const { admin, invoice } = await arrange(status);

        const res = await as(admin)
          .post(`/api/monthly-invoices/${invoice.id}/line-items`)
          .send({ description: 'Sneaky charge', quantity: 1, unitPrice: 999 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(new RegExp(status, 'i'));

        const after = await prisma.monthlyInvoice.findUnique({
          where: { id: invoice.id },
          include: { lineItems: true },
        });
        expect(after.lineItems).toHaveLength(1);
        expect(Number(after.totalAmount)).toBe(50);
      });

      it(`an ${status} invoice refuses a line-item deletion`, async () => {
        const { admin, invoice, lineId } = await arrange(status);

        const res = await as(admin).delete(
          `/api/monthly-invoices/${invoice.id}/line-items/${lineId}`
        );

        expect(res.status).toBe(400);
        await expect(
          prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } })
        ).resolves.toBe(1);
      });

      it(`an ${status} invoice cannot be deleted`, async () => {
        const { admin, invoice } = await arrange(status);

        const res = await as(admin).delete(`/api/monthly-invoices/${invoice.id}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cannot be deleted/i);
        await expect(
          prisma.monthlyInvoice.count({ where: { id: invoice.id } })
        ).resolves.toBe(1);
      });
    }

    it('a draft can still be deleted', async () => {
      const { admin, invoice } = await arrange('DRAFT');

      const res = await as(admin).delete(`/api/monthly-invoices/${invoice.id}`);

      expect(res.status).toBe(200);
    });
  });

  describe('transitions', () => {
    it('approves a draft', async () => {
      const { admin, invoice } = await arrange('DRAFT');

      const res = await as(admin).post(`/api/monthly-invoices/${invoice.id}/approve`);

      expect(res.status).toBe(200);
      await expect(statusOf(invoice.id)).resolves.toBe('APPROVED');
    });

    it('marks an approved invoice paid, recording when and against what', async () => {
      const { admin, invoice } = await arrange('APPROVED');

      const res = await as(admin)
        .post(`/api/monthly-invoices/${invoice.id}/pay`)
        .send({ paymentMethod: 'BACS', paymentReference: 'FT24019283' });

      expect(res.status).toBe(200);

      const after = await prisma.monthlyInvoice.findUnique({
        where: { id: invoice.id },
      });
      expect(after.status).toBe('PAID');
      expect(after.paidAt).toBeInstanceOf(Date);
      expect(after.paymentMethod).toBe('BACS');
      expect(after.paymentReference).toBe('FT24019283');
    });

    it('accepts payment without a method or reference', async () => {
      const { admin, invoice } = await arrange('APPROVED');

      const res = await as(admin).post(`/api/monthly-invoices/${invoice.id}/pay`).send({});

      expect(res.status).toBe(200);
      await expect(statusOf(invoice.id)).resolves.toBe('PAID');
    });

    it('refuses to pay a draft — it must be approved first', async () => {
      const { admin, invoice } = await arrange('DRAFT');

      const res = await as(admin).post(`/api/monthly-invoices/${invoice.id}/pay`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot become PAID/i);
      await expect(statusOf(invoice.id)).resolves.toBe('DRAFT');
    });

    it('treats PAID as terminal', async () => {
      const { admin, invoice } = await arrange('PAID');

      const paidAgain = await as(admin).post(`/api/monthly-invoices/${invoice.id}/pay`);
      const approved = await as(admin).post(`/api/monthly-invoices/${invoice.id}/approve`);

      expect(paidAgain.status).toBe(400);
      expect(paidAgain.body.error).toMatch(/final state/i);
      expect(approved.status).toBe(400);
    });

    it('refuses to re-approve an approved invoice', async () => {
      const { admin, invoice } = await arrange('APPROVED');

      const res = await as(admin).post(`/api/monthly-invoices/${invoice.id}/approve`);

      expect(res.status).toBe(400);
    });
  });

  describe('the lock does not block the warehouse', () => {
    it('dispatch still bills while this month is APPROVED, by rolling forward', async () => {
      // The interaction 2.2 could plausibly have broken: line items are now
      // DRAFT-only, and dispatch raises line items. resolveOpenInvoice skips
      // closed periods, so goods keep moving.
      const { admin, employee, client, product, location, stock } =
        await makeWarehouseScenario();

      const now = new Date();
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await makeInvoice(client.id, { billingPeriod: thisMonth, status: 'APPROVED' });

      // A per-item dispatch rate, because that is the only charge a dispatch
      // raises now — mapped services no longer ride along on a shipment.
      await makeShipmentRate(client.id, '5.00');

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
      const res = await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      expect(res.status).toBe(200);

      const invoices = await prisma.monthlyInvoice.findMany({
        where: { clientId: client.id },
        include: { lineItems: true },
        orderBy: { billingPeriod: 'asc' },
      });

      expect(invoices).toHaveLength(2);
      expect(invoices[0].status).toBe('APPROVED');
      expect(invoices[0].lineItems).toHaveLength(0);
      expect(invoices[1].status).toBe('DRAFT');
      expect(invoices[1].lineItems.length).toBeGreaterThan(0);
    });
  });

  describe('audit trail', () => {
    it('records approval and payment against the admin who did them', async () => {
      const { admin, invoice } = await arrange('DRAFT');

      await as(admin).post(`/api/monthly-invoices/${invoice.id}/approve`);
      await as(admin)
        .post(`/api/monthly-invoices/${invoice.id}/pay`)
        .send({ paymentMethod: 'BACS' });

      const logs = await prisma.auditLog.findMany({
        where: { action: { startsWith: 'INVOICE_' } },
        orderBy: { timestamp: 'asc' },
      });

      expect(logs.map((l) => l.action)).toEqual(['INVOICE_APPROVED', 'INVOICE_PAID']);
      expect(logs.every((l) => l.userId === admin.id)).toBe(true);
      expect(JSON.parse(logs[1].details).paymentMethod).toBe('BACS');
    });
  });
});
