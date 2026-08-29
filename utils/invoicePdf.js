'use strict';

/**
 * Renders an invoice to a PDF buffer.
 *
 * This layout was previously built in the browser (src/pages/client/index.tsx),
 * which meant there was no fixed record of what a client had been billed —
 * change a figure and the "old" invoice silently redrew with the new one. It is
 * now rendered once at approval and stored, so the document a client downloads
 * is the document they were sent.
 *
 * jsPDF is a browser library but runs cleanly under Node; verified producing a
 * valid %PDF-1.3 with a working autoTable.
 */

const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTableImport = require('jspdf-autotable');

const autoTable = autoTableImport.default || autoTableImport;

// Optional branding. public/Logo.png in the frontend is 1.6 MB, which would go
// into every invoice PDF, so it is deliberately not used. Drop a downscaled PNG
// (roughly 200x200, under ~40 KB) at this path and it will be picked up; the
// layout carries a text header and stands without one.
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'invoice-logo.png');

const ITEM_TYPE_LABELS = {
  AUTOMATED_SERVICE: 'Service',
  SHIPMENT_CHARGE: 'Shipment',
  MANUAL_CHARGE: 'Manual',
};

const money = (value) => Number(value ?? 0).toFixed(2);

const readLogo = () => {
  try {
    if (!fs.existsSync(LOGO_PATH)) return null;
    return `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;
  } catch {
    return null;
  }
};

/**
 * @param {object} invoice - with `client` and `lineItems` included
 * @returns {Buffer} the rendered PDF
 */
const renderInvoicePdf = (invoice) => {
  const doc = new jsPDF();

  const logo = readLogo();
  if (logo) {
    try {
      doc.addImage(logo, 'PNG', 14, 10, 30, 30);
    } catch {
      // A broken logo file must not cost us the invoice.
    }
  }

  const headerX = logo ? 50 : 14;

  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text('ProPackers UK', headerX, 22);
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text('Warehouse Management Services', headerX, 28);

  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text('INVOICE', 14, 52);

  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  const detailY = 60;
  doc.text(`Invoice ID: ${String(invoice.id).slice(0, 8).toUpperCase()}`, 14, detailY);
  doc.text(`Client: ${invoice.client?.companyName || '—'}`, 14, detailY + 6);
  doc.text(
    `Billing Period: ${new Date(invoice.billingPeriod).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })}`,
    14,
    detailY + 12,
  );
  doc.text(`Status: ${invoice.status}`, 14, detailY + 18);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-GB')}`, 14, detailY + 24);

  const items = invoice.lineItems || [];

  autoTable(doc, {
    startY: detailY + 32,
    head: [['Description', 'Type', 'Date', 'Qty', 'Unit Price (£)', 'Total (£)']],
    body: items.map((li) => [
      li.description,
      // All three types map explicitly. The browser version tested only for
      // AUTOMATED_SERVICE and labelled everything else "Manual", so the
      // SHIPMENT_CHARGE lines added in 2.1 were mislabelled.
      ITEM_TYPE_LABELS[li.itemType] || li.itemType,
      li.dateOfService
        ? new Date(li.dateOfService).toLocaleDateString('en-GB', { timeZone: 'UTC' })
        : '—',
      String(li.quantity),
      money(li.unitPrice),
      money(li.totalPrice),
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [15, 118, 110] },
  });

  const finalY = doc.lastAutoTable?.finalY || 120;

  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text(`Total Amount: £${money(invoice.totalAmount)}`, 14, finalY + 10);

  if (invoice.status === 'PAID' && invoice.paidAt) {
    doc.setFontSize(9);
    doc.setTextColor(22, 101, 52);
    const ref = invoice.paymentReference ? ` — ref ${invoice.paymentReference}` : '';
    const method = invoice.paymentMethod ? ` by ${invoice.paymentMethod}` : '';
    doc.text(
      `PAID ${new Date(invoice.paidAt).toLocaleDateString('en-GB')}${method}${ref}`,
      14,
      finalY + 17,
    );
  }

  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(
    'ProPackers UK — thank you for your business.',
    14,
    doc.internal.pageSize.getHeight() - 10,
  );

  return Buffer.from(doc.output('arraybuffer'));
};

/** Storage key for an invoice's PDF. Stable, so re-rendering overwrites. */
const invoicePdfKey = (invoice) => {
  const period = new Date(invoice.billingPeriod).toISOString().slice(0, 7);
  return `invoice-${period}-${invoice.id}.pdf`;
};

module.exports = { renderInvoicePdf, invoicePdfKey, ITEM_TYPE_LABELS };
