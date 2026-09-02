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
 * The layout follows the supplied INV0716.pdf: a full-width coloured header band
 * with the logo left, contacts beside it and the address right; BILL TO and the
 * invoice meta beneath; the line-item table; payment details; and a centred
 * footer.
 *
 * Which company issues it depends on whether tax was charged — see
 * ./invoiceIdentity. Everything that differs between the two entities comes from
 * there, so the bank account can never end up paired with the wrong company name.
 *
 * jsPDF is a browser library but runs cleanly under Node; verified producing a
 * valid %PDF-1.3 with a working autoTable.
 */

const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTableImport = require('jspdf-autotable');

const { identityFor } = require('./invoiceIdentity');

const autoTable = autoTableImport.default || autoTableImport;

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'invoice-logo.png');

/**
 * Human labels for the line types.
 *
 * Every value of the LineItemType enum must appear here. It previously listed
 * only three of them, so RECURRING_SERVICE and FBA_CHARGE — both added later —
 * fell through to the raw enum name and a client's invoice read "FBA_CHARGE" in
 * the Type column. There is a test walking the enum to keep this honest.
 */
const ITEM_TYPE_LABELS = {
  AUTOMATED_SERVICE: 'Service',
  SHIPMENT_CHARGE: 'Shipment',
  MANUAL_CHARGE: 'Manual',
  RECURRING_SERVICE: 'Monthly',
  FBA_CHARGE: 'FBA',
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

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-GB') : '—';

/**
 * @param {object} invoice - with `client` and `lineItems` included
 * @returns {Buffer} the rendered PDF
 */
const renderInvoicePdf = (invoice) => {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  const identity = identityFor(invoice);
  const [r, g, b] = identity.headerColor;

  const subtotal = Number(invoice.totalAmount ?? 0);
  const taxAmount = Number(invoice.taxAmount ?? 0);
  const taxed = Boolean(invoice.taxApplied) && taxAmount > 0;
  const grandTotal = subtotal + taxAmount;

  // ── Header band ────────────────────────────────────────────────────────────
  const bandHeight = 46;
  doc.setFillColor(r, g, b);
  doc.rect(0, 0, pageWidth, bandHeight, 'F');

  const logo = readLogo();
  if (logo) {
    // On a white plate, so a dark logo stays legible on the coloured band.
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(12, 7, 32, 32, 2, 2, 'F');
    doc.addImage(logo, 'PNG', 14, 9, 28, 28);
  }

  const textX = logo ? 50 : 14;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text(identity.companyName, textX, 16);

  // No personal name here, deliberately: the template carried one and it is not
  // wanted on either entity's invoices.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(identity.phone, textX, 24);
  doc.text(identity.email, textX, 30);
  doc.text(identity.website, textX, 36);

  const rightX = pageWidth - 14;
  let addrY = 16;
  for (const line of identity.address.lines) {
    doc.text(line, rightX, addrY, { align: 'right' });
    addrY += 6;
  }

  // ── Bill to / invoice meta ─────────────────────────────────────────────────
  let y = bandHeight + 14;

  doc.setTextColor(r, g, b);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('BILL TO', 14, y);

  doc.setTextColor(40, 40, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(invoice.client?.companyName || '—', 14, y + 7);
  if (invoice.client?.contactName) doc.text(invoice.client.contactName, 14, y + 13);
  if (invoice.client?.email) doc.text(invoice.client.email, 14, y + 19);

  doc.setTextColor(r, g, b);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('INVOICE', rightX, y, { align: 'right' });

  doc.setTextColor(90, 90, 90);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `No. ${String(invoice.id).slice(0, 8).toUpperCase()}`,
    rightX,
    y + 7,
    { align: 'right' },
  );
  doc.text(
    `Period: ${invoice.billingPeriod ? new Date(invoice.billingPeriod).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '—'}`,
    rightX,
    y + 13,
    { align: 'right' },
  );
  doc.text(`Date: ${formatDate(invoice.approvedAt || invoice.createdAt)}`, rightX, y + 19, {
    align: 'right',
  });
  doc.text(`Status: ${invoice.status}`, rightX, y + 25, { align: 'right' });

  // ── Line items ─────────────────────────────────────────────────────────────
  const rows = (invoice.lineItems || []).map((li) => [
    li.description,
    ITEM_TYPE_LABELS[li.itemType] || li.itemType,
    formatDate(li.dateOfService),
    String(li.quantity),
    money(li.unitPrice),
    money(li.totalPrice),
  ]);

  // Tax is drawn here, never stored as an InvoiceLineItem: a stored row would be
  // summed into totalAmount, which profit_loss reads as company earnings, and
  // VAT is collected for HMRC rather than earned.
  if (taxed) {
    rows.push([
      `Tax (${Number(invoice.taxRate)}%)`,
      'Tax',
      '',
      '',
      '',
      money(taxAmount),
    ]);
  }

  autoTable(doc, {
    startY: y + 34,
    head: [['Description', 'Type', 'Date', 'Qty', 'Unit Price (£)', 'Total (£)']],
    body: rows.length ? rows : [['No charges this period', '', '', '', '', '0.00']],
    theme: 'striped',
    headStyles: { fillColor: [r, g, b], textColor: 255, fontStyle: 'bold' },
    styles: { fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
    },
    margin: { left: 14, right: 14 },
  });

  const afterTable = doc.lastAutoTable?.finalY || y + 60;

  // ── Totals ─────────────────────────────────────────────────────────────────
  let ty = afterTable + 10;

  if (taxed) {
    doc.setFontSize(10);
    doc.setTextColor(90, 90, 90);
    doc.text(`Subtotal: £${money(subtotal)}`, rightX, ty, { align: 'right' });
    ty += 6;
    doc.text(`Tax (${Number(invoice.taxRate)}%): £${money(taxAmount)}`, rightX, ty, {
      align: 'right',
    });
    ty += 8;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(r, g, b);
  doc.text(
    `${taxed ? 'Total Due' : 'Total Amount'}: £${money(grandTotal)}`,
    rightX,
    ty,
    { align: 'right' },
  );

  if (invoice.status === 'PAID' && invoice.paidAt) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(22, 101, 52);
    const ref = invoice.paymentReference ? ` — ref ${invoice.paymentReference}` : '';
    const method = invoice.paymentMethod ? ` by ${invoice.paymentMethod}` : '';
    doc.text(`PAID ${formatDate(invoice.paidAt)}${method}${ref}`, rightX, ty + 7, {
      align: 'right',
    });
  }

  // ── Payment details ────────────────────────────────────────────────────────
  // The account belongs to the issuing entity. Both come from one table, so the
  // name and the account number cannot drift apart.
  let py = ty + 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(r, g, b);
  doc.text('Bank Details', 14, py);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  doc.text(`Name: ${identity.bank.name}`, 14, py + 6);
  doc.text(`Sort Code: ${identity.bank.sortCode}`, 14, py + 12);
  doc.text(`Account: ${identity.bank.accountNumber}`, 14, py + 18);

  // ── Footer ─────────────────────────────────────────────────────────────────
  const pageHeight = doc.internal.pageSize.getHeight();
  const centreX = pageWidth / 2;
  let fy = pageHeight - 26;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(r, g, b);
  doc.text('Thank You For Your Business !', centreX, fy, { align: 'center' });
  fy += 6;

  // Registration numbers only where they belong. Pro Packers is not VAT
  // registered, and printing another entity's numbers under its name would be a
  // misstatement on a tax document.
  if (identity.registration) {
    doc.setFontSize(9);
    doc.setTextColor(40, 40, 40);
    doc.text(
      `Company No. ${identity.registration.companyNumber} - VAT No: ${identity.registration.vatNumber}`,
      centreX,
      fy,
      { align: 'center' },
    );
    fy += 6;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  doc.text(`${identity.address.oneLine} | ${identity.phone}`, centreX, fy, {
    align: 'center',
  });

  return Buffer.from(doc.output('arraybuffer'));
};

/** Stable storage key, so an invoice's PDF is always found at the same place. */
const invoicePdfKey = (invoice) => {
  const period = invoice.billingPeriod
    ? new Date(invoice.billingPeriod).toISOString().slice(0, 7)
    : 'unknown';
  return `invoice-${period}-${invoice.id}.pdf`;
};

module.exports = { renderInvoicePdf, invoicePdfKey, ITEM_TYPE_LABELS };
