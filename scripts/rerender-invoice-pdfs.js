#!/usr/bin/env node
'use strict';

/**
 * Re-renders the stored PDF of existing invoices, so a change to the invoice
 * layout or to the fixed company details (utils/invoicePdf, utils/invoiceIdentity)
 * shows on invoices that were approved before it.
 *
 * Stored PDFs are otherwise only re-rendered when an APPROVED invoice's lines or
 * tax are edited, so a code change alone never reaches them. DRAFT invoices need
 * nothing: they are rendered when approved.
 *
 * Quiet by design: it overwrites the stored file in place and does NOT email
 * clients, unlike an edit. By default only APPROVED invoices are touched — a PAID
 * invoice is a settled record. Pass --include-paid to refresh those too, which
 * only changes how the document looks, never its figures.
 *
 * Safe to run more than once. Reports what it did.
 *
 *   npm run rerender:invoices:dry        list what it would do, write nothing
 *   npm run rerender:invoices            approved invoices only
 *   npm run rerender:invoices:all:dry    as above, including paid invoices
 *   npm run rerender:invoices:all        approved and paid invoices
 *
 * The flags are baked into separate npm scripts rather than passed after `--`:
 * in PowerShell npm swallows the `--`, so `npm run x -- --include-paid` reaches
 * the script with no flags at all — and `--dry-run` would silently write.
 * (node scripts/rerender-invoice-pdfs.js --dry-run works in any shell.)
 */

require('dotenv').config();

const { prisma } = require('../lib/prisma');
const monthlyInvoiceRepository = require('../repositories/monthly_invoice.repository');
const objectStorage = require('../lib/objectStorage');
const { renderInvoicePdf, invoicePdfKey } = require('../utils/invoicePdf');

const args = new Set(process.argv.slice(2));
// npm turns flags it swallowed into npm_config_* variables, so honour those too:
// a --dry-run that was dropped must not become a real run.
const flag = (name) => args.has(`--${name}`) || process.env[`npm_config_${name.replace(/-/g, '_')}`] === 'true';
const dryRun = flag('dry-run');
const includePaid = flag('include-paid');

const run = async () => {
  const statuses = includePaid ? ['APPROVED', 'PAID'] : ['APPROVED'];
  const invoices = await prisma.monthlyInvoice.findMany({
    where: { status: { in: statuses } },
    select: { id: true, status: true, pdfLink: true, billingPeriod: true },
    orderBy: { billingPeriod: 'asc' },
  });

  console.log(
    `\n  rerender:invoices — ${invoices.length} ${statuses.join('/')} invoice(s)` +
      `${dryRun ? ' (dry run, nothing written)' : ''}:\n`,
  );

  let done = 0;
  let failed = 0;
  for (const { id, status, pdfLink, billingPeriod } of invoices) {
    try {
      // Re-read through the repository: the renderer needs the client and line
      // items, which the listing above does not carry.
      const invoice = await monthlyInvoiceRepository.getMonthlyInvoiceById(id);
      const key = pdfLink || invoicePdfKey(invoice);
      if (!dryRun) {
        await objectStorage.uploadBuffer(key, renderInvoicePdf(invoice), 'application/pdf');
        if (pdfLink !== key) {
          await monthlyInvoiceRepository.updateMonthlyInvoice(id, { pdfLink: key });
        }
      }
      done += 1;
      console.log(`    ${dryRun ? 'would render' : 'rendered   '} ${status.padEnd(8)} ${key}`);
    } catch (err) {
      failed += 1;
      console.error(
        `    FAILED     ${status.padEnd(8)} ${id} (${new Date(billingPeriod).toISOString().slice(0, 7)}): ${err.message}`,
      );
    }
  }

  console.log(`\n  ${done} of ${invoices.length} PDF(s) ${dryRun ? 'would be ' : ''}re-rendered.\n`);
  return failed;
};

run()
  .then(async (failures) => {
    await prisma.$disconnect();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('\n  rerender:invoices failed:', err.message, '\n');
    await prisma.$disconnect();
    process.exit(1);
  });
