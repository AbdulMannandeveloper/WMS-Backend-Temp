/**
 * The stored invoice PDF.
 *
 * `pdfLink` existed as a column that nothing ever filled. The client portal
 * rebuilt the PDF in the browser on every view, so there was no fixed record of
 * what a client had been billed — change a figure and the "old" invoice silently
 * redrew with the new one.
 *
 * Chunk 2.3 renders it once at approval and stores it through the same
 * objectStorage helper expense receipts use.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeClient,
  makeInvoice,
  makeUser,
} from '../factories/index.js';

/** An approved invoice carrying one line of each billable type. */
const arrangeApproved = async () => {
  const admin = await makeAdmin();
  const { user: clientUser, client } = await makeClient();
  const invoice = await makeInvoice(client.id);

  await as(admin)
    .post(`/api/monthly-invoices/${invoice.id}/line-items`)
    .send({ description: 'Pallet handling', quantity: 2, unitPrice: 25 });

  await as(admin).post(`/api/monthly-invoices/${invoice.id}/approve`);

  return { admin, clientUser, client, invoice };
};

describe('invoice PDF', () => {
  it('is rendered and stored when the invoice is approved', async () => {
    const { invoice } = await arrangeApproved();

    const after = await prisma.monthlyInvoice.findUnique({ where: { id: invoice.id } });

    expect(after.status).toBe('APPROVED');
    expect(after.pdfLink).toBeTruthy();
    expect(after.pdfLink).toMatch(/\.pdf$/);
  });

  it('downloads as a real PDF', async () => {
    const { admin, invoice } = await arrangeApproved();

    const res = await as(admin)
      .get(`/api/monthly-invoices/${invoice.id}/pdf`)
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('lets the owning client download their own invoice', async () => {
    const { clientUser, invoice } = await arrangeApproved();

    const res = await as(clientUser).get(`/api/monthly-invoices/${invoice.id}/pdf`);

    expect(res.status).toBe(200);
  });

  it("404s another client's invoice rather than revealing it exists", async () => {
    const { invoice } = await arrangeApproved();
    const { user: otherClientUser } = await makeClient({
      companyName: 'Somebody Else Ltd',
    });

    const res = await as(otherClientUser).get(`/api/monthly-invoices/${invoice.id}/pdf`);

    expect(res.status).toBe(404);
  });

  it('refuses an employee and an anonymous caller', async () => {
    const { invoice } = await arrangeApproved();
    const employee = await makeUser({ role: 'employee' });

    await expect(
      as(employee).get(`/api/monthly-invoices/${invoice.id}/pdf`).then((r) => r.status)
    ).resolves.toBe(403);
    await expect(
      anon().get(`/api/monthly-invoices/${invoice.id}/pdf`).then((r) => r.status)
    ).resolves.toBe(401);
  });

  it('regenerates rather than failing when the stored file is gone', async () => {
    const { admin, invoice } = await arrangeApproved();

    // Simulate the object being lost from storage.
    const { pdfLink } = await prisma.monthlyInvoice.findUnique({
      where: { id: invoice.id },
    });
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stored = path.default.join(process.cwd(), 'uploads', pdfLink);
    if (fs.default.existsSync(stored)) fs.default.unlinkSync(stored);

    const res = await as(admin).get(`/api/monthly-invoices/${invoice.id}/pdf`);

    expect(res.status).toBe(200);
    expect(fs.default.existsSync(stored)).toBe(true);
  });

  it('recovers an invoice approved while storage was down', async () => {
    // The state a storage outage leaves behind: APPROVED, no pdfLink. Reproduced
    // directly rather than by mocking the storage module — the app holds its own
    // reference to it, so patching the export does not reach the call site, and a
    // mock that cannot fail makes the test pass for the wrong reason.
    const { admin, invoice } = await arrangeApproved();

    await prisma.monthlyInvoice.update({
      where: { id: invoice.id },
      data: { pdfLink: null },
    });

    const res = await as(admin).get(`/api/monthly-invoices/${invoice.id}/pdf`);

    // The approval stands on its own; the document is rendered on demand, so an
    // outage at approval time is not permanent.
    expect(res.status).toBe(200);
    const after = await prisma.monthlyInvoice.findUnique({ where: { id: invoice.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.pdfLink).toBeTruthy();
  });

  it('labels every line type, including SHIPMENT_CHARGE', async () => {
    const { ITEM_TYPE_LABELS } = await import('../../utils/invoicePdf.js').then(
      (m) => m.default
    );

    // The browser version tested only for AUTOMATED_SERVICE and called
    // everything else "Manual", so 2.1's shipment charges were mislabelled.
    expect(ITEM_TYPE_LABELS.AUTOMATED_SERVICE).toBe('Service');
    expect(ITEM_TYPE_LABELS.SHIPMENT_CHARGE).toBe('Shipment');
    expect(ITEM_TYPE_LABELS.MANUAL_CHARGE).toBe('Manual');
  });
});
