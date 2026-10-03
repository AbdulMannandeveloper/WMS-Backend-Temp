/**
 * Stored files go when the record that points at them goes.
 *
 * What must hold:
 *   - Deleting an expense removes its receipt; replacing or removing a receipt
 *     removes the old file.
 *   - Removing a freight document removes its file; deleting a freight shipment
 *     removes every document's file.
 *   - A file still pointed at by another record stays.
 *   - A key that would leave the upload directory is refused.
 *
 * Runs against local-disk storage, which the suite points at a disposable
 * directory (UPLOAD_DIR).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeExpense, makeFreightShipment } from '../factories/index.js';
import objectStorage from '../../lib/objectStorage.js';

const { localUploadDir, deleteObject } = objectStorage;

/** Writes a stored file and returns its key. */
const storedFile = (prefix) => {
  const key = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
  fs.writeFileSync(path.join(localUploadDir, key), 'pdf');
  return key;
};

const exists = (key) => fs.existsSync(path.join(localUploadDir, key));

const receiptUrl = (key) => `/api/expenses/receipt/${key}`;

describe('expense receipts', () => {
  it('go when the expense is deleted', async () => {
    const admin = await makeAdmin();
    const key = storedFile('receipt');
    const expense = await makeExpense(null, { receiptImageUrl: receiptUrl(key) });

    expect((await as(admin).delete(`/api/expenses/${expense.id}`)).status).toBe(200);

    expect(exists(key)).toBe(false);
  });

  it('go when replaced or removed on an edit', async () => {
    const admin = await makeAdmin();
    const first = storedFile('receipt');
    const second = storedFile('receipt');
    const expense = await makeExpense(null, { receiptImageUrl: receiptUrl(first) });

    await as(admin).put(`/api/expenses/${expense.id}`).send({ receiptImageUrl: receiptUrl(second) });
    expect(exists(first)).toBe(false);
    expect(exists(second)).toBe(true);

    await as(admin).put(`/api/expenses/${expense.id}`).send({ receiptImageUrl: null });
    expect(exists(second)).toBe(false);
  });

  it('stay while another expense still uses them', async () => {
    const admin = await makeAdmin();
    const key = storedFile('receipt');
    const one = await makeExpense(null, { receiptImageUrl: receiptUrl(key) });
    await makeExpense(null, { receiptImageUrl: receiptUrl(key) });

    await as(admin).delete(`/api/expenses/${one.id}`);

    expect(exists(key)).toBe(true);
  });

  it('stay untouched when an edit leaves the receipt alone', async () => {
    const admin = await makeAdmin();
    const key = storedFile('receipt');
    const expense = await makeExpense(null, { receiptImageUrl: receiptUrl(key) });

    await as(admin).put(`/api/expenses/${expense.id}`).send({ description: 'Toner' });

    expect(exists(key)).toBe(true);
  });
});

describe('freight documents', () => {
  const attach = (shipment, key) =>
    prisma.freightShipmentDocument.create({
      data: {
        freightShipmentId: shipment.id,
        fileName: 'booking.pdf',
        storageKey: key,
        fileType: 'application/pdf',
      },
    });

  it('go when the document is removed', async () => {
    const admin = await makeAdmin();
    const shipment = await makeFreightShipment();
    const key = storedFile(`freight-${shipment.id}`);
    const document = await attach(shipment, key);

    const res = await as(admin).delete(`/api/freight-shipments/${shipment.id}/documents/${document.id}`);

    expect(res.status).toBe(200);
    expect(exists(key)).toBe(false);
  });

  it('all go when the shipment is deleted', async () => {
    const admin = await makeAdmin();
    const shipment = await makeFreightShipment();
    const keys = [storedFile(`freight-${shipment.id}`), storedFile(`freight-${shipment.id}`)];
    for (const key of keys) await attach(shipment, key);

    expect((await as(admin).delete(`/api/freight-shipments/${shipment.id}`)).status).toBe(200);

    expect(keys.map(exists)).toEqual([false, false]);
  });
});

describe('deleting a stored object', () => {
  it('refuses a key that leaves the upload directory', async () => {
    await expect(deleteObject('../outside.txt')).rejects.toThrow(/Invalid file path/);
  });

  it('treats a file already gone as done', async () => {
    await expect(deleteObject('never-existed.pdf')).resolves.toBeUndefined();
  });
});
