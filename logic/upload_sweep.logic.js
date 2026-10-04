'use strict';

const { prisma } = require('../lib/prisma');
const { listObjects, removeStoredFile } = require('../lib/objectStorage');

/**
 * Stored files that no record points at.
 *
 * A receipt is uploaded the moment it is picked, before the expense it belongs
 * to is saved, so a form closed without saving leaves its file behind. An
 * air-freight manifest or photo is stored before its row is written, so a row
 * that fails to write does the same. Deletes already remove the files they let
 * go of; these were never let go of, because nothing ever held them.
 *
 * Only files at least a day old are touched. One uploaded a minute ago may
 * belong to a form that is still open.
 */

const GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_AFTER_MS = 60 * 1000;

/** How the receipt upload names a stored receipt (expense.controller uploadReceipt). */
const RECEIPT_URL_PREFIX = '/api/expenses/receipt/';

/**
 * Each kind of upload: the prefix its keys carry, and which of a batch of keys
 * a record still points at.
 */
const KINDS = [
  {
    prefix: 'receipt-',
    referenced: async (keys) => {
      const rows = await prisma.expense.findMany({
        where: { receiptImageUrl: { in: keys.map((key) => RECEIPT_URL_PREFIX + key) } },
        select: { receiptImageUrl: true },
      });
      return new Set(rows.map((row) => row.receiptImageUrl.slice(RECEIPT_URL_PREFIX.length)));
    },
  },
  {
    // An air-freight manifest is stored before its upload row is written, so a
    // failed preview leaves the file behind. The storage key is held verbatim.
    prefix: 'afmanifest-',
    referenced: async (keys) => {
      const rows = await prisma.airFreightUpload.findMany({
        where: { storageKey: { in: keys } },
        select: { storageKey: true },
      });
      return new Set(rows.map((row) => row.storageKey));
    },
  },
  {
    // Damage / label-issue photos: on the exception that raised them, and on the
    // box event that recorded them. Kept while either still points at the key.
    prefix: 'afphoto-',
    referenced: async (keys) => {
      const [excs, events] = await Promise.all([
        prisma.airFreightException.findMany({ where: { photoKey: { in: keys } }, select: { photoKey: true } }),
        prisma.airFreightBoxEvent.findMany({ where: { photoKey: { in: keys } }, select: { photoKey: true } }),
      ]);
      return new Set([...excs, ...events].map((r) => r.photoKey));
    },
  },
  {
    // Handover proof-of-delivery photos.
    prefix: 'afproof-',
    referenced: async (keys) => {
      const rows = await prisma.airFreightHandover.findMany({
        where: { proofPhotoKey: { in: keys } },
        select: { proofPhotoKey: true },
      });
      return new Set(rows.map((row) => row.proofPhotoKey));
    },
  },
  {
    // Client replacement-label files, on the exception the client uploaded them to.
    prefix: 'aflabel-',
    referenced: async (keys) => {
      const rows = await prisma.airFreightException.findMany({
        where: { clientLabelKey: { in: keys } },
        select: { clientLabelKey: true },
      });
      return new Set(rows.map((row) => row.clientLabelKey));
    },
  },
];

/**
 * Removes every upload older than the grace period that no record points at.
 *
 * @param {{ now?: Date }} [options]  the moment to measure age from; for tests
 * @returns {Promise<{ removed: string[] }>} the keys removed
 */
const sweepOrphanedUploads = async ({ now = new Date() } = {}) => {
  const cutoff = now.getTime() - GRACE_MS;
  const removed = [];

  for (const kind of KINDS) {
    const old = (await listObjects(kind.prefix))
      .filter((object) => object.lastModified.getTime() <= cutoff)
      .map((object) => object.key);
    if (old.length === 0) continue;

    const kept = await kind.referenced(old);
    for (const key of old) {
      if (kept.has(key)) continue;
      await removeStoredFile(key);
      removed.push(key);
    }
  }

  return { removed };
};

/**
 * Runs the sweep shortly after the server starts, then daily. Timers are
 * unref'd, so they never hold a shutting-down process open. Running on two
 * instances at once is harmless: removing a file already gone is not an error.
 */
const scheduleUploadSweep = () => {
  const run = () =>
    sweepOrphanedUploads()
      .then(({ removed }) => {
        if (removed.length) console.log(`[Uploads] Removed ${removed.length} file(s) no record points at`);
      })
      .catch((err) => console.error('[Uploads] Sweep failed:', err.message));

  setTimeout(run, FIRST_SWEEP_AFTER_MS).unref?.();
  setInterval(run, SWEEP_EVERY_MS).unref?.();
};

module.exports = { sweepOrphanedUploads, scheduleUploadSweep, GRACE_MS };
