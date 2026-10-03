/**
 * The sweep for uploads nothing points at.
 *
 * A receipt is stored when it is picked, before its expense is saved, so a
 * form closed without saving left the file behind for good. The same for a
 * freight document whose row never got written.
 *
 * What must hold:
 *   - A day-old receipt or freight document that no record points at goes.
 *   - One a record points at stays, however old.
 *   - One under a day old stays: its form may still be open.
 *   - Nothing else in storage is touched.
 *
 * Runs against local-disk storage, which the suite points at a disposable
 * directory (UPLOAD_DIR).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { makeExpense, makeFreightShipment } from '../factories/index.js';
import objectStorage from '../../lib/objectStorage.js';
import uploadSweep from '../../logic/upload_sweep.logic.js';

const { localUploadDir } = objectStorage;
const { sweepOrphanedUploads } = uploadSweep;

const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

/** Writes a stored file, backdated when `old`, and returns its key. */
const storedFile = (prefix, { old = true } = {}) => {
  const key = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
  const full = path.join(localUploadDir, key);
  fs.writeFileSync(full, 'pdf');
  if (old) fs.utimesSync(full, TWO_DAYS_AGO, TWO_DAYS_AGO);
  return key;
};

const exists = (key) => fs.existsSync(path.join(localUploadDir, key));

describe('the upload sweep', () => {
  it('removes old receipts and freight documents that nothing points at', async () => {
    const receipt = storedFile('receipt');
    const document = storedFile('freight');

    const { removed } = await sweepOrphanedUploads();

    expect(removed).toEqual(expect.arrayContaining([receipt, document]));
    expect(exists(receipt)).toBe(false);
    expect(exists(document)).toBe(false);
  });

  it('keeps what a record points at, however old', async () => {
    const receipt = storedFile('receipt');
    await makeExpense(null, { receiptImageUrl: `/api/expenses/receipt/${receipt}` });
    const shipment = await makeFreightShipment();
    const document = storedFile('freight');
    await prisma.freightShipmentDocument.create({
      data: { freightShipmentId: shipment.id, fileName: 'slip.pdf', storageKey: document, fileType: 'application/pdf' },
    });

    await sweepOrphanedUploads();

    expect(exists(receipt)).toBe(true);
    expect(exists(document)).toBe(true);
  });

  it('keeps an upload under a day old, whose form may still be open', async () => {
    const fresh = storedFile('receipt', { old: false });

    await sweepOrphanedUploads();

    expect(exists(fresh)).toBe(true);
  });

  it('touches nothing that is not an upload it knows', async () => {
    const other = storedFile('archive');

    await sweepOrphanedUploads();

    expect(exists(other)).toBe(true);
  });
});
