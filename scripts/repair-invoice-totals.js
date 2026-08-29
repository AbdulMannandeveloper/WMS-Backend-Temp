#!/usr/bin/env node
'use strict';

/**
 * Reconciles monthly_invoices.total_amount against the sum of each invoice's
 * line items.
 *
 * Chunk 1.1 made the total a derived value, so from now on it cannot drift.
 * This exists for two reasons: to clean up rows written by the old accumulator
 * (which concatenated instead of adding — a £100 invoice plus a £50 charge
 * became £10,050), and as a standing audit anyone can run to prove the books
 * agree.
 *
 *   node scripts/repair-invoice-totals.js            report only (default)
 *   node scripts/repair-invoice-totals.js --apply    write the corrections
 *
 * Reads DATABASE_URL from .env like the rest of the app. Check which database
 * that points at before using --apply.
 */

require('dotenv').config();

const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');

const APPLY = process.argv.includes('--apply');

const money = (value) => Number(value).toFixed(2);

const main = async () => {
  const url = process.env.DATABASE_URL || '';
  const target = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return '(unparseable DATABASE_URL)';
    }
  })();

  console.log(`\nInvoice total reconciliation`);
  console.log(`  database : ${target}`);
  console.log(`  mode     : ${APPLY ? 'APPLY — corrections will be written' : 'dry run — no writes'}\n`);

  const invoices = await prisma.monthlyInvoice.findMany({
    include: { lineItems: { select: { totalPrice: true } } },
    orderBy: { billingPeriod: 'asc' },
  });

  if (invoices.length === 0) {
    console.log('  No invoices found. Nothing to do.\n');
    return { checked: 0, drifted: 0, repaired: 0 };
  }

  const drifted = [];
  const emptyButNonZero = [];

  for (const invoice of invoices) {
    // Sum with Decimal.plus rather than `+`: adding a Prisma Decimal to a
    // number concatenates, which is the very bug this script cleans up after.
    const expected = invoice.lineItems.reduce(
      (acc, line) => acc.plus(line.totalPrice),
      new Prisma.Decimal(0)
    );

    if (!expected.equals(invoice.totalAmount)) {
      const row = { invoice, expected };
      drifted.push(row);
      if (invoice.lineItems.length === 0) emptyButNonZero.push(row);
    }
  }

  if (drifted.length === 0) {
    console.log(`  ${invoices.length} invoice(s) checked — all totals agree with their line items.\n`);
    return { checked: invoices.length, drifted: 0, repaired: 0 };
  }

  console.log(`  ${drifted.length} of ${invoices.length} invoice(s) disagree with their line items:\n`);
  console.log('    invoice   status    lines        stored       should be');
  console.log('    ────────  ────────  ─────  ────────────  ────────────');

  for (const { invoice, expected } of drifted) {
    console.log(
      `    ${invoice.id.slice(0, 8)}  ${invoice.status.padEnd(8)}  ` +
        `${String(invoice.lineItems.length).padStart(5)}  ` +
        `${money(invoice.totalAmount).padStart(12)}  ${money(expected).padStart(12)}`
    );
  }

  if (emptyButNonZero.length > 0) {
    console.log(
      `\n  Note: ${emptyButNonZero.length} of these have no line items at all, so the derived` +
        `\n  total is 0.00. If any was a deliberate manual figure, capture it as a line item` +
        `\n  before applying — otherwise the amount is simply lost.`
    );
  }

  if (!APPLY) {
    console.log(`\n  Dry run. Re-run with --apply to write these corrections.\n`);
    return { checked: invoices.length, drifted: drifted.length, repaired: 0 };
  }

  // One transaction: either the books reconcile completely or nothing moves.
  await prisma.$transaction(
    drifted.map(({ invoice, expected }) =>
      prisma.monthlyInvoice.update({
        where: { id: invoice.id },
        data: { totalAmount: expected },
      })
    )
  );

  console.log(`\n  Repaired ${drifted.length} invoice(s).\n`);
  return { checked: invoices.length, drifted: drifted.length, repaired: drifted.length };
};

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\n  Failed: ${err.message}\n`);
    await prisma.$disconnect();
    process.exit(1);
  });
