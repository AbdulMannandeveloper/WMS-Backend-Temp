/**
 * A2 — invoice totals are string-concatenated, not added.
 *
 * logic/monthly_invoice.logic.js:75
 *   data.totalAmount = existingInvoice.totalAmount + data.amountToAdjust;
 *
 * `totalAmount` is a Prisma Decimal, whose valueOf() returns a string, so `+`
 * concatenates. Decimal('100.00') + 50 === "10050". Every manually added charge
 * corrupts the invoice, and the `< 0` guard on the next line silently passes
 * because it is comparing a string.
 *
 * Fixed by chunk 1.1 (derive the total with SUM over line items).
 *
 * Written with `it.fails`, which passes only while the body throws. When 1.1
 * lands these start failing, which is the signal to delete `.fails` and keep
 * them as permanent regression tests.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeInvoice } from '../factories/index.js';

const arrangeInvoice = async () => {
  const admin = await makeAdmin();
  const { client } = await makeClient();
  const invoice = await makeInvoice(client.id, { totalAmount: '100.00' });
  return { admin, invoice };
};

describe('A2 — invoice total arithmetic', () => {
  it.fails('adding a £50 line item to a £100 invoice gives £150', async () => {
    const { admin, invoice } = await arrangeInvoice();

    const res = await as(admin)
      .post(`/api/monthly-invoices/${invoice.id}/line-items`)
      .send({
        description: 'Pallet handling',
        quantity: 1,
        unitPrice: 50,
        dateOfService: new Date().toISOString(),
      });

    expect(res.status).toBe(201);

    const updated = await prisma.monthlyInvoice.findUnique({
      where: { id: invoice.id },
    });

    // Today: "10050". £100 becomes £10,050.
    expect(Number(updated.totalAmount)).toBe(150);
  });

  it.fails('removing that line item returns the invoice to £100', async () => {
    const { admin, invoice } = await arrangeInvoice();

    const created = await as(admin)
      .post(`/api/monthly-invoices/${invoice.id}/line-items`)
      .send({
        description: 'Pallet handling',
        quantity: 1,
        unitPrice: 50,
        dateOfService: new Date().toISOString(),
      });

    const deleted = await as(admin).delete(
      `/api/monthly-invoices/${invoice.id}/line-items/${created.body.id}`
    );

    // Today: builds the string "100.00-50", which Postgres rejects as a numeric.
    expect(deleted.status).toBe(200);

    const updated = await prisma.monthlyInvoice.findUnique({
      where: { id: invoice.id },
    });
    expect(Number(updated.totalAmount)).toBe(100);
  });

  it.fails('the stored total always equals the sum of its line items', async () => {
    const { admin, invoice } = await arrangeInvoice();

    for (const unitPrice of [10, 20, 30]) {
      await as(admin)
        .post(`/api/monthly-invoices/${invoice.id}/line-items`)
        .send({
          description: `Charge ${unitPrice}`,
          quantity: 1,
          unitPrice,
          dateOfService: new Date().toISOString(),
        });
    }

    const [updated, lines] = await Promise.all([
      prisma.monthlyInvoice.findUnique({ where: { id: invoice.id } }),
      prisma.invoiceLineItem.findMany({ where: { invoiceId: invoice.id } }),
    ]);

    const sumOfLines = lines.reduce((acc, l) => acc + Number(l.totalPrice), 0);

    // The invariant chunk 1.1 introduces: the total is derived, never accumulated.
    expect(Number(updated.totalAmount)).toBe(100 + sumOfLines);
  });
});
