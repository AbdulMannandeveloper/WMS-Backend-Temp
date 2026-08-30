/**
 * Tax on an invoice.
 *
 * A platform-wide rate, opted into per invoice while it is still DRAFT.
 *
 * Two decisions shape all of it. totalAmount stays EX-TAX, because
 * profit_loss.logic.js reads it as company earnings and VAT is collected for
 * HMRC rather than earned — folding tax in would overstate profit by the whole
 * rate. And the rate is snapshotted onto the invoice when tax is applied, so
 * changing the platform rate next April does not silently restate every invoice
 * ever issued.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeInvoice,
  makeInvoiceLineItem,
} from '../factories/index.js';

/** A DRAFT invoice carrying `subtotal` worth of lines. */
const arrange = async (subtotal = '100.00') => {
  const scenario = await makeWarehouseScenario();
  const invoice = await makeInvoice(scenario.client.id);
  await makeInvoiceLineItem(invoice.id, {
    quantity: '1.00',
    unitPrice: subtotal,
    totalPrice: subtotal,
  });
  // Derive the total the way the application does.
  const repo = await import('../../repositories/monthly_invoice.repository.js');
  await repo.default.recalculateInvoiceTotal(invoice.id);

  return { ...scenario, invoice };
};

const reload = (id) => prisma.monthlyInvoice.findUnique({ where: { id } });

describe('the platform tax rate', () => {
  it('defaults to 20 before anyone sets it', async () => {
    // A fresh install silently charging no VAT is a worse failure than one
    // charging the standard rate: nobody notices money that was never added.
    const { admin } = await arrange();

    const res = await as(admin).get('/api/monthly-invoices/tax-rate');

    expect(res.status).toBe(200);
    expect(res.body.rate).toBe(20);
  });

  it('is readable by staff, who see what would be added', async () => {
    const { employeeUser } = await arrange();
    expect((await as(employeeUser).get('/api/monthly-invoices/tax-rate')).status).toBe(200);
  });

  it('is changed by an admin, and persists', async () => {
    const { admin } = await arrange();

    await as(admin).put('/api/monthly-invoices/tax-rate').send({ rate: 17.5 });

    const res = await as(admin).get('/api/monthly-invoices/tax-rate');
    expect(res.body.rate).toBe(17.5);
  });

  it('is not changed by an employee', async () => {
    const { employeeUser } = await arrange();

    const res = await as(employeeUser)
      .put('/api/monthly-invoices/tax-rate')
      .send({ rate: 0 });

    expect(res.status).toBe(403);
  });

  it('refuses a rate outside 0 to 100', async () => {
    const { admin } = await arrange();

    for (const rate of [-5, 101]) {
      const res = await as(admin).put('/api/monthly-invoices/tax-rate').send({ rate });
      expect(res.status).toBe(400);
    }
  });

  it('refuses something that is not a number', async () => {
    const { admin } = await arrange();

    const res = await as(admin)
      .put('/api/monthly-invoices/tax-rate')
      .send({ rate: 'twenty' });

    expect(res.status).toBe(400);
  });

  it('resolves "tax-rate" as the setting, not as an invoice id', async () => {
    // Express matches in declaration order. Declared after GET /:id, this route
    // is captured by it and looked up as an invoice whose id is the literal
    // string "tax-rate" — which is exactly how it was written the first time.
    const { admin } = await arrange();

    const res = await as(admin).get('/api/monthly-invoices/tax-rate');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rate');
  });

  it('refuses an anonymous request', async () => {
    expect((await anon().get('/api/monthly-invoices/tax-rate')).status).toBe(401);
  });
});

describe('applying tax to a draft invoice', () => {
  it('adds tax at the platform rate without touching the subtotal', async () => {
    const ctx = await arrange('100.00');

    const res = await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    expect(res.status).toBe(200);
    const after = await reload(ctx.invoice.id);
    expect(Number(after.totalAmount)).toBe(100); // still ex-tax
    expect(Number(after.taxAmount)).toBe(20);
    expect(Number(after.taxRate)).toBe(20);
    expect(after.taxApplied).toBe(true);
  });

  it('leaves totalAmount ex-tax, so profit and loss is not inflated', async () => {
    // The whole reason tax is a separate column. VAT is collected for HMRC, not
    // earned, so it must never appear in the figure the P&L reads as revenue.
    const ctx = await arrange('250.00');

    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    const after = await reload(ctx.invoice.id);
    expect(Number(after.totalAmount)).toBe(250);
    expect(Number(after.totalAmount) + Number(after.taxAmount)).toBe(300);
  });

  it('uses whatever rate is current when it is applied', async () => {
    const ctx = await arrange('200.00');
    await as(ctx.admin).put('/api/monthly-invoices/tax-rate').send({ rate: 5 });

    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    const after = await reload(ctx.invoice.id);
    expect(Number(after.taxAmount)).toBe(10);
  });

  it('freezes that rate — changing the platform rate later does not restate it', async () => {
    // Otherwise every invoice ever issued silently changes value the day the
    // rate moves.
    const ctx = await arrange('100.00');
    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    await as(ctx.admin).put('/api/monthly-invoices/tax-rate').send({ rate: 50 });

    const after = await reload(ctx.invoice.id);
    expect(Number(after.taxRate)).toBe(20);
    expect(Number(after.taxAmount)).toBe(20);
  });

  it('removes the tax again', async () => {
    const ctx = await arrange('100.00');
    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: false });

    const after = await reload(ctx.invoice.id);
    expect(after.taxApplied).toBe(false);
    expect(Number(after.taxAmount)).toBe(0);
  });

  it('rounds to pennies', async () => {
    const ctx = await arrange('33.33');

    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    const after = await reload(ctx.invoice.id);
    expect(Number(after.taxAmount)).toBe(6.67); // 33.33 * 0.20 = 6.666
  });

  it('is admin only', async () => {
    const ctx = await arrange();

    const res = await as(ctx.employeeUser)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    expect(res.status).toBe(403);
  });

  it('404s an invoice that does not exist', async () => {
    const ctx = await arrange();

    const res = await as(ctx.admin)
      .post('/api/monthly-invoices/00000000-0000-0000-0000-000000000000/tax')
      .send({ applied: true });

    expect(res.status).toBe(404);
  });
});

describe('tax follows the subtotal while the invoice is open', () => {
  it('recalculates when a line item is added afterwards', async () => {
    // A dispatch mid-month adds a line and moves the subtotal. A tax figure
    // calculated once when the box was ticked would go stale and undercharge
    // for the rest of the period.
    const ctx = await arrange('100.00');
    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    await makeInvoiceLineItem(ctx.invoice.id, {
      quantity: '1.00',
      unitPrice: '100.00',
      totalPrice: '100.00',
    });
    const repo = await import('../../repositories/monthly_invoice.repository.js');
    await repo.default.recalculateInvoiceTotal(ctx.invoice.id);

    const after = await reload(ctx.invoice.id);
    expect(Number(after.totalAmount)).toBe(200);
    expect(Number(after.taxAmount)).toBe(40);
  });

  it('stays at zero when tax was never applied', async () => {
    const ctx = await arrange('100.00');

    await makeInvoiceLineItem(ctx.invoice.id, {
      quantity: '1.00',
      unitPrice: '50.00',
      totalPrice: '50.00',
    });
    const repo = await import('../../repositories/monthly_invoice.repository.js');
    await repo.default.recalculateInvoiceTotal(ctx.invoice.id);

    const after = await reload(ctx.invoice.id);
    expect(Number(after.taxAmount)).toBe(0);
  });
});

describe('once the invoice is out of draft', () => {
  it('tax cannot be applied to an approved invoice', async () => {
    // It has been sent. The amount a client was asked to pay must not move
    // underneath them.
    const ctx = await arrange('100.00');
    await prisma.monthlyInvoice.update({
      where: { id: ctx.invoice.id },
      data: { status: 'APPROVED' },
    });

    const res = await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DRAFT/i);
  });

  it('tax cannot be removed from a paid invoice', async () => {
    const ctx = await arrange('100.00');
    await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: true });
    await prisma.monthlyInvoice.update({
      where: { id: ctx.invoice.id },
      data: { status: 'PAID' },
    });

    const res = await as(ctx.admin)
      .post(`/api/monthly-invoices/${ctx.invoice.id}/tax`)
      .send({ applied: false });

    expect(res.status).toBe(400);
    const after = await reload(ctx.invoice.id);
    expect(Number(after.taxAmount)).toBe(20);
  });
});
