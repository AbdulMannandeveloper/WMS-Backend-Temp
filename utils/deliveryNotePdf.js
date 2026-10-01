'use strict';

/**
 * Renders a bulk shipment's delivery note to a PDF buffer.
 *
 * The layout follows the supplied Template.pdf: the Nayoram header, a grid of
 * shipment facts (note number, date, references, carrier, boxes, pallets), the
 * deliver-to and invoice-address blocks, the goods table with totals, then the
 * driver's and customer's signature boxes, a shortages box, and the black
 * footer bar saying it is not a VAT invoice.
 *
 * Issued by Nayoram, as in the template. Its name, contacts, registration and
 * logo come from ./invoiceIdentity so they cannot drift from the invoices'.
 *
 * Rendered on request rather than stored: this is a packing document, and one
 * printed after an address is corrected should carry the corrected address.
 */

const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTableImport = require('jspdf-autotable');

const { NAYORAM } = require('./invoiceIdentity');

const autoTable = autoTableImport.default || autoTableImport;

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

const NAVY = [31, 56, 100];
const INK = [20, 20, 20];
const RULE = [70, 70, 70];
const LABEL_FILL = [220, 228, 240];
const MARGIN = 14;

const readLogo = (file) => {
  try {
    const full = path.join(ASSETS_DIR, file);
    if (!fs.existsSync(full)) return null;
    const format = /\.jpe?g$/i.test(file) ? 'JPEG' : 'PNG';
    const mime = format === 'JPEG' ? 'image/jpeg' : 'image/png';
    return { dataUri: `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`, format };
  } catch {
    return null;
  }
};

const text = (value) => (value === null || value === undefined ? '' : String(value));
const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-GB') : '');

/**
 * A small grey-blue caption cell, as the template's field labels. colSpan is a
 * property of the cell, not a style, so it is lifted out of extra.
 */
const label = (content, { colSpan, ...extra } = {}) => ({
  content,
  ...(colSpan ? { colSpan } : {}),
  styles: {
    fillColor: LABEL_FILL,
    fontStyle: 'bold',
    fontSize: 6.5,
    cellPadding: { top: 0.7, bottom: 0.7, left: 1.2, right: 1.2 },
    ...extra,
  },
});

/** A value cell beneath a caption. */
const value = (content, extra = {}) => ({
  content: text(content),
  styles: { fontStyle: 'bold', fontSize: 9, ...extra },
});

const gridStyles = {
  theme: 'grid',
  styles: {
    font: 'helvetica',
    textColor: INK,
    lineColor: RULE,
    lineWidth: 0.2,
    fontSize: 7.5,
    cellPadding: 0.8,
    valign: 'middle',
  },
  margin: { left: MARGIN, right: MARGIN },
};

/**
 * Fixed columns for a grid whose first row spans several of them. autoTable
 * counts columns from the first row's cells, not their spans, so without this
 * a spanning caption row collapses the table to one or two columns.
 */
const columns = (widths) => ({
  columns: widths.map((_, i) => ({ header: '', dataKey: i })),
  showHead: 'never',
  columnStyles: Object.fromEntries(widths.map((cellWidth, i) => [i, { cellWidth }])),
});

/** Units per box, when it divides out; a blank when nobody said how many boxes. */
const unitsPerBox = (quantity, boxes) => {
  if (!boxes) return '';
  const per = quantity / boxes;
  return Number.isInteger(per) ? String(per) : per.toFixed(1);
};

/**
 * @param {object} shipment - an FbaShipment with client and items (with product) included
 * @returns {Buffer} the rendered PDF
 */
const renderDeliveryNotePdf = (shipment) => {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const rightX = pageWidth - MARGIN;
  const identity = NAYORAM;

  const items = shipment.items || [];
  const totalUnits = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const anyBoxes = items.some((item) => item.boxes);
  const totalBoxes = items.reduce((sum, item) => sum + Number(item.boxes || 0), 0);

  // ── Header ─────────────────────────────────────────────────────────────────
  const logo = readLogo(identity.logo);
  if (logo) doc.addImage(logo.dataUri, logo.format, MARGIN + 2, 9, 30, 30);

  const textX = logo ? MARGIN + 42 : MARGIN;
  doc.setTextColor(...NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(identity.companyName.toUpperCase(), textX, 18);

  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  let hy = 25;
  for (const line of identity.address.lines) {
    doc.text(line, textX, hy);
    hy += 4.5;
  }
  if (identity.registration) {
    doc.text(`Company No: ${identity.registration.companyNumber}`, textX, hy);
    doc.text(`VAT No: GB ${identity.registration.vatNumber}`, textX, hy + 4.5);
  }

  doc.setTextColor(...NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('DELIVERY NOTE', rightX, 22, { align: 'right' });

  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Tel: ${identity.phone}`, rightX, 34, { align: 'right' });
  doc.text(`Email: ${identity.email}`, rightX, 39, { align: 'right' });

  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, 45, rightX, 45);

  // ── Shipment facts ─────────────────────────────────────────────────────────
  const client = shipment.client || {};
  const account = [client.companyName, client.clientUniqueNumber && `(${client.clientUniqueNumber})`]
    .filter(Boolean)
    .join(' ');

  autoTable(doc, {
    ...gridStyles,
    startY: 49,
    ...columns([45.5, 45.5, 45.5, 45.5]),
    body: [
      [label('DELIVERY NOTE NO.'), label('DATE'), label('ORDER / INVOICE REF'), label('CUSTOMER ACCOUNT')],
      [value(shipment.reference), value(formatDate(shipment.receivedAt)), value(shipment.orderReference), value(account)],
      [label('CARRIER / DRIVER NAME'), label('VEHICLE REGISTRATION'), label('NO. OF BOXES'), label('NO. OF PALLETS')],
      [
        value(shipment.dispatchMode, { halign: 'center' }),
        value(shipment.vehicleRegistration, { halign: 'center' }),
        value(anyBoxes ? totalBoxes : '', { halign: 'center' }),
        value(shipment.palletCount ?? '', { halign: 'center' }),
      ],
    ],
  });

  // ── Deliver to / invoice address ───────────────────────────────────────────
  const caption = (content) => ({ content, styles: { fontStyle: 'bold', fontSize: 8 } });
  autoTable(doc, {
    ...gridStyles,
    // Left, explicitly: the supplied template right-aligned the phone number,
    // which was a slip in the template rather than the intended layout.
    styles: { ...gridStyles.styles, halign: 'left' },
    startY: doc.lastAutoTable.finalY + 4,
    ...columns([28, 63, 28, 63]),
    body: [
      [
        label('DELIVER TO (CUSTOMER)', { colSpan: 2, fontSize: 7.5 }),
        label('INVOICE ADDRESS (IF DIFFERENT)', { colSpan: 2, fontSize: 7.5 }),
      ],
      [caption('Name / Company'), text(shipment.destination), caption('Name / Company'), ''],
      [
        caption('Address'),
        { content: text(shipment.deliveryAddress), styles: { minCellHeight: 10, valign: 'top' } },
        { content: 'Address', styles: { fontStyle: 'bold', fontSize: 8, valign: 'top' } },
        '',
      ],
      [caption('Postcode'), text(shipment.deliveryPostcode), caption('Postcode'), ''],
      [caption('Contact / Tel'), text(shipment.deliveryContact), caption('Contact / Tel'), ''],
      ...(shipment.deliveryNote
        ? [[caption('Instructions'), { content: text(shipment.deliveryNote), colSpan: 3 }]]
        : []),
    ],
  });

  // ── Goods ──────────────────────────────────────────────────────────────────
  const rows = items.map((item, i) => [
    String(i + 1),
    text(item.product?.skuCode),
    text(item.product?.productName),
    text(item.boxes || ''),
    unitsPerBox(item.quantity, item.boxes),
    String(item.quantity),
    '',
  ]);
  // A spare line, as the template leaves, for anything added at the door.
  rows.push([String(items.length + 1), '', '', '', '', '', '']);

  const centred = { halign: 'center' };
  autoTable(doc, {
    ...gridStyles,
    startY: doc.lastAutoTable.finalY + 4,
    head: [['Item', 'Product Code / SKU', 'Description', 'No. of\nBoxes', 'Units\nper Box', 'Total\nUnits', 'Notes']],
    body: rows,
    foot: [[
      { content: 'TOTALS', colSpan: 3, styles: { halign: 'right' } },
      { content: anyBoxes ? String(totalBoxes) : '', styles: centred },
      '',
      { content: String(totalUnits), styles: centred },
      '',
    ]],
    showFoot: 'lastPage',
    bodyStyles: { fontSize: 7, cellPadding: { top: 0.55, bottom: 0.55, left: 1.2, right: 1.2 } },
    headStyles: { fillColor: LABEL_FILL, textColor: INK, fontStyle: 'bold', fontSize: 7.5, halign: 'center' },
    footStyles: { fillColor: LABEL_FILL, textColor: INK, fontStyle: 'bold', fontSize: 8.5 },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 36 },
      2: { cellWidth: 48 },
      3: { cellWidth: 16, halign: 'center' },
      4: { cellWidth: 16, halign: 'center' },
      5: { cellWidth: 16, halign: 'center' },
      6: { cellWidth: 40 },
    },
  });

  // ── Signatures and shortages ───────────────────────────────────────────────
  // Each block is kept whole: a signature box split across a page break is a
  // box nobody can sign.
  const FOOTER_SPACE = 18;
  const ensureSpace = (height) => {
    let y = doc.lastAutoTable.finalY + 4;
    if (y + height > pageHeight - FOOTER_SPACE) {
      doc.addPage();
      y = MARGIN + 6;
    }
    return y;
  };

  const signatureBlock = (title, statement) => {
    autoTable(doc, {
      ...gridStyles,
      startY: ensureSpace(24),
      ...columns([100, 30, 52]),
      body: [
        [label(title, { colSpan: 3, fontSize: 7.5, textColor: NAVY })],
        [{ content: statement, colSpan: 3, styles: { fontStyle: 'italic', fontSize: 6 } }],
        [label('SIGNATURE'), label('PRINT NAME'), label('DATE & TIME')],
        [{ content: '', styles: { minCellHeight: 8 } }, '', ''],
      ],
    });
  };

  signatureBlock(
    'COLLECTED BY DRIVER',
    'I confirm I have collected the goods listed above and that the number of boxes/pallets is correct and in good external condition at the point of collection.',
  );
  signatureBlock(
    'RECEIVED BY CUSTOMER',
    'I confirm receipt of the goods listed above in good condition. Any shortage or damage has been noted in the box below before signing.',
  );

  autoTable(doc, {
    ...gridStyles,
    startY: ensureSpace(19),
    ...columns([182]),
    body: [
      [label('SHORTAGES, DAMAGE OR DISCREPANCIES NOTED ON DELIVERY', { fontSize: 7.5 })],
      [{ content: '', styles: { minCellHeight: 10 } }],
    ],
  });

  // ── Footer bar ─────────────────────────────────────────────────────────────
  const barY = doc.lastAutoTable.finalY + 5;
  doc.setFillColor(0, 0, 0);
  doc.rect(MARGIN, barY, pageWidth - MARGIN * 2, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text(
    'Please check all goods at the time of delivery. Claims for shortage or damage cannot be accepted unless noted on this delivery note.',
    pageWidth / 2,
    barY + 4,
    { align: 'center' },
  );
  doc.text('This is a delivery note only and is not a VAT invoice.', pageWidth / 2, barY + 8, {
    align: 'center',
  });

  // Page numbers, only when the goods ran onto a second page.
  const pages = doc.getNumberOfPages();
  if (pages > 1) {
    doc.setTextColor(120, 120, 120);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    for (let page = 1; page <= pages; page += 1) {
      doc.setPage(page);
      doc.text(`${shipment.reference} - page ${page} of ${pages}`, rightX, pageHeight - 8, {
        align: 'right',
      });
    }
  }

  return Buffer.from(doc.output('arraybuffer'));
};

module.exports = { renderDeliveryNotePdf };
