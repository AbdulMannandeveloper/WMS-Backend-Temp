/**
 * Invoice totals.
 *
 * The invariant: monthly_invoices.total_amount always equals
 * SUM(invoice_line_items.total_price) for that invoice. It is a projection, not
 * a running balance.
 *
 * These began life in test/known-bugs/ describing the opposite behaviour — the
 * total was accumulated in JavaScript with `decimalTotal + number`, which
 * concatenates rather than adds, so a £100 invoice plus a £50 charge became
 * £10,050 and deleting a line item errored on "100.00-50". Chunk 1.1 replaced
 * that with a SUM computed in Postgres, and these are now the regression suite
 * guarding it.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeInvoice } from '../factories/index.js';

const arrange = async () => {
  const admin = await makeAdmin();
  const { client } = await makeClient();
  const invoice = await makeInvoice(client.id);
  return { admin, client, invoice };
};

const addLine = (admin, invoiceId, { unitPrice, quantity = 1, description = 'Charge' }) =>
  as(admin)
    .post(`/api/monthly-invoices/${invoiceId}/line-items`)
    .send({
      description,
      quantity,
      unitPrice,
      dateOfService: new Date().toISOString(),
    });

const totalOf = async (invoiceId) => {
  const inv = await prisma.monthlyInvoice.findUnique({ where: { id: invoiceId } });
  return Number(inv.totalAmount);
};

describe('invoice totals', () => {
  it('adding a £50 line item to an empty invoice gives £50', async () => {
    const { admin, invoice } = await arrange();

    const res = await addLine(admin, invoice.id, { unitPrice: 50 });

    expect(res.status).toBe(201);
    // Previously "050" — the concatenation bug.
    await expect(totalOf(invoice.id)).resolves.toBe(50);
  });

  it('removing that line item returns the invoice to zero', async () => {
    const { admin, invoice } = await arrange();

    const created = await addLine(admin, invoice.id, { unitPrice: 50 });
    const deleted = await as(admin).delete(
      `/api/monthly-invoices/${invoice.id}/line-items/${created.body.id}`
    );

    // Previously 400: the delete path built the string "50.00-50".
    expect(deleted.status).toBe(200);
    await expect(totalOf(invoice.id)).resolves.toBe(0);
  });

  it('the stored total always equals the sum of its line items', async () => {
    const { admin, invoice } = await arrange();

    for (const unitPrice of [10, 20, 30]) {
      await addLine(admin, invoice.id, { unitPrice, description: `Charge ${unitPrice}` });
    }

    const lines = await prisma.invoiceLineItem.findMany({
      where: { invoiceId: invoice.id },
    });
    const sumOfLines = lines.reduce((acc, l) => acc + Number(l.totalPrice), 0);

    expect(sumOfLines).toBe(60);
    await expect(totalOf(invoice.id)).resolves.toBe(sumOfLines);
  });

  it('sums fractional amounts exactly, without float drift', async () => {
    const { admin, invoice } = await arrange();

    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. This test fails the moment
    // anyone routes the total back through a JavaScript float.
    await addLine(admin, invoice.id, { unitPrice: 0.1 });
    await addLine(admin, invoice.id, { unitPrice: 0.2 });

    const inv = await prisma.monthlyInvoice.findUnique({ where: { id: invoice.id } });

    expect(inv.totalAmount.toFixed(2)).toBe('0.30');
  });

  it('stays exact across many line items', async () => {
    const { admin, invoice } = await arrange();

    for (let i = 0; i < 25; i++) {
      await addLine(admin, invoice.id, { unitPrice: 0.01, description: `Penny ${i}` });
    }

    await expect(totalOf(invoice.id)).resolves.toBe(0.25);
  });

  it('multiplies quantity by unit price for a single line', async () => {
    const { admin, invoice } = await arrange();

    await addLine(admin, invoice.id, { unitPrice: 12.5, quantity: 4 });

    await expect(totalOf(invoice.id)).resolves.toBe(50);
  });

  it('follows an edit to a line item', async () => {
    const { admin, invoice } = await arrange();
    const created = await addLine(admin, invoice.id, { unitPrice: 50 });

    const invoiceLineItemLogic = await import('../../logic/invoice_line_item.logic.js');
    await invoiceLineItemLogic.default.updateInvoiceLineItem(created.body.id, {
      totalPrice: 75,
    });

    await expect(totalOf(invoice.id)).resolves.toBe(75);
  });

  it('is idempotent — recalculating twice changes nothing', async () => {
    const { admin, invoice } = await arrange();
    await addLine(admin, invoice.id, { unitPrice: 42.5 });

    const repo = await import('../../repositories/monthly_invoice.repository.js');
    await repo.default.recalculateInvoiceTotal(invoice.id);
    await repo.default.recalculateInvoiceTotal(invoice.id);

    await expect(totalOf(invoice.id)).resolves.toBe(42.5);
  });

  it('resolves an invoice with no line items to zero, not null', async () => {
    const { invoice } = await arrange();

    // Seed a bogus non-zero total so the assertion below can only pass if
    // recalculate actually ran — the factory creates invoices at 0.00.
    await prisma.monthlyInvoice.update({
      where: { id: invoice.id },
      data: { totalAmount: '123.45' },
    });

    const repo = await import('../../repositories/monthly_invoice.repository.js');
    await repo.default.recalculateInvoiceTotal(invoice.id);

    const inv = await prisma.monthlyInvoice.findUnique({ where: { id: invoice.id } });
    expect(inv.totalAmount).not.toBeNull();
    expect(Number(inv.totalAmount)).toBe(0);
  });

  it('ignores totalAmount sent in an update request', async () => {
    const { admin, invoice } = await arrange();
    await addLine(admin, invoice.id, { unitPrice: 50 });

    await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}`)
      .send({ totalAmount: 999999 });

    await expect(totalOf(invoice.id)).resolves.toBe(50);
  });

  it('ignores the removed amountToAdjust backdoor', async () => {
    const { admin, invoice } = await arrange();
    await addLine(admin, invoice.id, { unitPrice: 50 });

    await as(admin)
      .put(`/api/monthly-invoices/${invoice.id}`)
      .send({ amountToAdjust: 10000 });

    await expect(totalOf(invoice.id)).resolves.toBe(50);
  });

  it('leaves the total untouched when a line item is rejected', async () => {
    const { admin, invoice } = await arrange();
    await addLine(admin, invoice.id, { unitPrice: 50 });

    const rejected = await addLine(admin, invoice.id, { unitPrice: 10, quantity: 0 });

    expect(rejected.status).toBe(400);
    await expect(totalOf(invoice.id)).resolves.toBe(50);
    await expect(
      prisma.invoiceLineItem.count({ where: { invoiceId: invoice.id } })
    ).resolves.toBe(1);
  });
});
