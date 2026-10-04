'use strict';

/**
 * Renders a flight's billing statement to a PDF buffer: the charge lines with
 * their formulas, the settings used, the per-client-reference breakdown, and the
 * total. Mirrors the jspdf/jspdf-autotable interop of the other PDFs.
 */

const { jsPDF } = require('jspdf');
const autoTableImport = require('jspdf-autotable');

const autoTable = autoTableImport.default || autoTableImport;
const NAVY = [31, 56, 100];
const MARGIN = 14;

const renderFlightBillingPdf = (flight, statement) => {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  doc.setFontSize(16);
  doc.setTextColor(...NAVY);
  doc.text('Air Freight Billing', MARGIN, 18);

  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  doc.text(`Flight: ${flight.reference}${flight.mawbNumber ? `  MAWB ${flight.mawbNumber}` : ''}`, MARGIN, 27);
  const s = statement.settings || {};
  doc.text(`Chargeable weight: ${s.method ?? '—'}   Divisor: ${s.divisor ?? '—'}   Rounding: ${s.roundingIncrementKg ?? '—'} kg   Free storage: ${s.freeStorageHours ?? '—'} h`, MARGIN, 33);

  const lines = statement.lines ?? [];
  autoTable(doc, {
    startY: 40,
    head: [['Charge', 'Formula', 'Qty', 'Unit price', 'Total']],
    body: lines.map((l) => [l.label, l.formula, String(l.quantity), `£${Number(l.unitPrice).toFixed(2)}`, `£${Number(l.total).toFixed(2)}`]),
    foot: [['', '', '', 'Total', `£${Number(statement.totals?.total ?? 0).toFixed(2)}`]],
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: NAVY },
    margin: { left: MARGIN, right: MARGIN },
  });

  const breakdown = statement.breakdown ?? [];
  if (breakdown.length) {
    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY ?? 40) + 8,
      head: [['Client ref', 'Boxes', 'Chargeable kg', 'Storage box-days']],
      body: breakdown.map((b) => [b.clientReference, String(b.boxes), String(b.chargeableKg), String(b.storageBoxDays)]),
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: NAVY },
      margin: { left: MARGIN, right: MARGIN },
    });
  }

  if (lines.length === 0) {
    doc.setFontSize(10);
    doc.text('No charges — no agreed rates or no billable boxes.', MARGIN, (doc.lastAutoTable?.finalY ?? 40) + 10);
  }

  return Buffer.from(doc.output('arraybuffer'));
};

module.exports = { renderFlightBillingPdf };
