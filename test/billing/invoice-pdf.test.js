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
    // Resolve the same way lib/objectStorage.js does, so this keeps working
    // wherever UPLOAD_DIR points — the suite writes to a disposable directory.
    const storageRoot = process.env.UPLOAD_DIR
      ? path.default.resolve(process.cwd(), process.env.UPLOAD_DIR)
      : path.default.join(process.cwd(), 'uploads');
    const stored = path.default.join(storageRoot, pdfLink);

    expect(fs.default.existsSync(stored)).toBe(true); // it was written on approval
    fs.default.unlinkSync(stored);

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

  it('labels every line type there is', async () => {
    const { ITEM_TYPE_LABELS } = await import('../../utils/invoicePdf.js').then(
      (m) => m.default
    );

    // Enumerated from the schema rather than listed by hand. This test used to
    // check three of them, so RECURRING_SERVICE and FBA_CHARGE were added later
    // with no label and fell through to the raw enum — a client's invoice read
    // "FBA_CHARGE" in the Type column. Walking the whole enum means the next
    // line type cannot be added without one.
    const ALL_TYPES = [
      'AUTOMATED_SERVICE',
      'SHIPMENT_CHARGE',
      'MANUAL_CHARGE',
      'RECURRING_SERVICE',
      'FBA_CHARGE',
    ];

    for (const type of ALL_TYPES) {
      expect(ITEM_TYPE_LABELS[type], `no label for ${type}`).toBeTruthy();
      // A label that is just the enum name back again is not a label.
      expect(ITEM_TYPE_LABELS[type]).not.toBe(type);
      expect(ITEM_TYPE_LABELS[type]).not.toMatch(/_/);
    }
  });

  it('covers exactly the types the database can produce', async () => {
    // Catches a type being removed from the schema and left here, and a new one
    // being added to the schema and missed.
    const { ITEM_TYPE_LABELS } = await import('../../utils/invoicePdf.js').then(
      (m) => m.default
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT unnest(enum_range(NULL::"LineItemType"))::text AS value`
    );
    const fromDb = rows.map((r) => r.value).sort();

    expect(Object.keys(ITEM_TYPE_LABELS).sort()).toEqual(fromDb);
  });
});
