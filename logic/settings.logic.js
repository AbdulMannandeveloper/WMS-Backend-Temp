'use strict';

/**
 * Platform-wide settings.
 *
 * Key/value in the database rather than environment variables, so a value can be
 * changed without a redeploy and carries who changed it and when. A tax rate is
 * exactly the kind of number somebody has to account for later.
 */

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const TAX_RATE_KEY = 'TAX_RATE';

/** UK VAT. The rate an admin has not yet chosen anything else. */
const DEFAULT_TAX_RATE = 20;

const getSetting = async (key, tx) => {
  const row = await db(tx).setting.findUnique({ where: { key } });
  return row?.value ?? null;
};

const setSetting = async (key, value, updatedById, tx) =>
  await db(tx).setting.upsert({
    where: { key },
    update: { value: String(value), updatedById: updatedById ?? null },
    create: { key, value: String(value), updatedById: updatedById ?? null },
  });

/**
 * The platform tax rate, as a percentage.
 *
 * Falls back to the default rather than to zero when unset: a fresh install
 * silently charging no VAT is a worse failure than one charging the standard
 * rate, because nobody notices money that was never added.
 */
const getTaxRate = async (tx) => {
  const raw = await getSetting(TAX_RATE_KEY, tx);
  if (raw === null) return DEFAULT_TAX_RATE;

  const rate = Number(raw);
  return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_TAX_RATE;
};

const setTaxRate = async (rate, updatedById) => {
  const value = Number(rate);
  if (!Number.isFinite(value)) {
    throw new Error('Tax rate must be a number.');
  }
  if (value < 0 || value > 100) {
    throw new Error('Tax rate must be between 0 and 100.');
  }

  // Two decimals: rates like 12.5 exist, rates like 20.005 do not.
  const rounded = Math.round(value * 100) / 100;
  await setSetting(TAX_RATE_KEY, rounded, updatedById);
  return rounded;
};

/** Tax on a subtotal, rounded to pennies. */
const taxOn = (subtotal, rate) =>
  Number(((Number(subtotal) * Number(rate)) / 100).toFixed(2));

module.exports = {
  TAX_RATE_KEY,
  DEFAULT_TAX_RATE,
  getSetting,
  setSetting,
  getTaxRate,
  setTaxRate,
  taxOn,
};
