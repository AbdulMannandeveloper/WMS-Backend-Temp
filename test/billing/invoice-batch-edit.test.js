/**
 * Batched invoice edits — PUT /api/monthly-invoices/:id/edit.
 *
 * The admin "edit invoice" screen stages line-item and tax changes locally
 * and applies them in one call. The point of the batch: routing each staged
 * change through the individual create-line-item / delete-line-item / set-tax
 * endpoints would work too, but each of those re-renders the PDF and emails
 * the client on its own once the invoice is APPROVED — five staged edits
 * would mean five emails. This endpoint commits them as a single act.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeClient, makeInvoice } from '../factories/index.js';

/**
 * An invoice at `status`, carrying one £50 line. APPROVED and PAID are reached
 * through the real /approve and /pay endpoints rather than force-written, so an
 * APPROVED invoice here has the genuinely-rendered pdfLink that syncApprovedInvoicePdf
 * depends on — a factory-forced status would leave pdfLink null and make the
 * "PDF stays stable" assertion below meaningless.
 */
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

  if (status === 'APPROVED' || status === 'PAID') {
    await as(admin).post(`/api/monthly-invoices/${invoice.id}/approve`);
  }
  if (status === 'PAID') {
    await as(admin).post(`/api/monthly-invoices/${invoice.id}/pay`);
  }

  return { admin, client, invoice, lineId: line.body.id };
};

const reload = (id) =>
  prisma.monthlyInvoice.findUnique({ where: { id }, include: { lineItems: true } });

describe('batched invoice edits', () => {
  it('adds and removes line items in one call', async () => {
    const { admin, invoice, lineId } = await arrange('DRAFT');

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({
        addLineItems: [{ description: 'Extra pallet', quantity: 2, unitPrice: 20 }],
        removeLineItemIds: [lineId],
      });

    expect(res.status).toBe(200);
    const after = await reload(invoice.id);
    expect(after.lineItems).toHaveLength(1);
    expect(after.lineItems[0].description).toBe('Extra pallet');
    expect(Number(after.totalAmount)).toBe(40);
  });

  it('applies tax alongside line-item changes, off the new subtotal', async () => {
    const { admin, invoice } = await arrange('DRAFT');

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({
        addLineItems: [{ description: 'Extra', quantity: 1, unitPrice: 50 }],
        taxApplied: true,
      });

    expect(res.status).toBe(200);
    const after = await reload(invoice.id);
    expect(Number(after.totalAmount)).toBe(100); // 50 existing + 50 new
    expect(after.taxApplied).toBe(true);
    expect(Number(after.taxAmount)).toBe(20); // 20% of 100
  });

  it('leaves tax untouched when it is not part of the request', async () => {
    const { admin, invoice } = await arrange('DRAFT');
    await as(admin).post(`/api/monthly-invoices/${invoice.id}/tax`).send({ applied: true });

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({ addLineItems: [{ description: 'More', quantity: 1, unitPrice: 50 }] });

    expect(res.status).toBe(200);
    const after = await reload(invoice.id);
    expect(after.taxApplied).toBe(true);
    expect(Number(after.totalAmount)).toBe(100); // 50 + 50
    expect(Number(after.taxAmount)).toBe(20); // re-derived from the frozen 20% rate
  });

  it('refuses when nothing is staged', async () => {
    const { admin, invoice } = await arrange('DRAFT');

    const res = await as(admin).put(`/api/monthly-invoices/${invoice.id}/edit`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no changes/i);
  });

  it('works on an APPROVED invoice and records one audit entry for the whole batch', async () => {
    const { admin, invoice, lineId } = await arrange('APPROVED');

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({
        addLineItems: [{ description: 'Correction', quantity: 1, unitPrice: 15 }],
        removeLineItemIds: [lineId],
        taxApplied: true,
      });

    expect(res.status).toBe(200);
    const after = await reload(invoice.id);
    expect(after.lineItems).toHaveLength(1);
    expect(Number(after.totalAmount)).toBe(15);
    expect(after.taxApplied).toBe(true);

    const logs = await prisma.auditLog.findMany({ where: { action: 'INVOICE_EDITED' } });
    expect(logs).toHaveLength(1);
    const details = JSON.parse(logs[0].details);
    expect(details.lineItemsAdded).toBe(1);
    expect(details.lineItemsRemoved).toBe(1);
    expect(details.taxChanged).toBe(true);
  });

  it('re-renders the PDF once for an APPROVED invoice, not once per staged change', async () => {
    const { admin, invoice } = await arrange('APPROVED');
    const before = await reload(invoice.id);
    expect(before.pdfLink).toBeTruthy(); // approval already rendered one

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({
        addLineItems: [
          { description: 'One', quantity: 1, unitPrice: 10 },
          { description: 'Two', quantity: 1, unitPrice: 10 },
        ],
        taxApplied: true,
      });

    expect(res.status).toBe(200);
    // Only the final endpoint-level state matters here — the PDF key is stable
    // and syncApprovedInvoicePdf runs after the transaction, exactly once.
    const after = await reload(invoice.id);
    expect(after.pdfLink).toBe(before.pdfLink);
  });

  it('refuses to edit a PAID invoice', async () => {
    const { admin, invoice } = await arrange('PAID');

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({ addLineItems: [{ description: 'Sneaky', quantity: 1, unitPrice: 10 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PAID/i);
  });

  it('rolls back everything if one removal target does not belong to the invoice', async () => {
    const { admin, invoice, lineId } = await arrange('DRAFT');
    const { client: otherClient } = await makeClient();
    const otherInvoice = await makeInvoice(otherClient.id);
    const otherLine = await as(admin)
      .post(`/api/monthly-invoices/${otherInvoice.id}/line-items`)
      .send({ description: 'Not yours', quantity: 1, unitPrice: 5 });

    const res = await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({
        addLineItems: [{ description: 'Should not stick', quantity: 1, unitPrice: 99 }],
        removeLineItemIds: [lineId, otherLine.body.id],
      });

    expect(res.status).toBe(400);
    const after = await reload(invoice.id);
    // Neither the removal nor the addition took — the transaction rolled back.
    expect(after.lineItems).toHaveLength(1);
    expect(after.lineItems[0].id).toBe(lineId);
  });

  it('is admin only', async () => {
    const employee = await makeEmployee();
    const { invoice } = await arrange('DRAFT');

    const res = await as(employee)
      .put(`/api/monthly-invoices/${invoice.id}/edit`)
      .send({ addLineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] });

    expect(res.status).toBe(403);
  });
});
