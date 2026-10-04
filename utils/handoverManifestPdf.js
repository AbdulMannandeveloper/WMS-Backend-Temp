'use strict';

/**
 * Renders a handover's manifest to a PDF buffer: the sheet the driver and depot
 * staff sign when boxes change hands. Header (HO reference, courier, depot,
 * vehicle, date), the box table (#, tracking, flight, client ref, weight), a
 * total, then signature lines for the driver and depot staff.
 *
 * Built from the live handover before close, and from its boxSnapshot after —
 * the caller passes whichever rows are current. jspdf/jspdf-autotable interop
 * mirrors utils/deliveryNotePdf.js.
 */

const { jsPDF } = require('jspdf');
const autoTableImport = require('jspdf-autotable');

const autoTable = autoTableImport.default || autoTableImport;

const NAVY = [31, 56, 100];
const MARGIN = 14;

const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * @param {object} handover  the handover record (with courier, depot)
 * @param {Array<{trackingNumber,flightReference,clientReference,weightKg,outcome}>} rows
 */
const renderHandoverManifestPdf = (handover, rows) => {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.setTextColor(...NAVY);
  doc.text('Handover Manifest', MARGIN, 18);

  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  const facts = [
    `Reference: ${handover.reference}`,
    `Courier: ${handover.courier?.code ?? ''} ${handover.courier?.name ?? ''}`.trim(),
    `Depot: ${handover.depotName ?? '—'}`,
    `Vehicle: ${handover.vehicleReg ?? '—'}   Driver: ${handover.driverName ?? '—'}`,
    `Opened: ${fmtDate(handover.openedAt)}`,
  ];
  facts.forEach((line, i) => doc.text(line, MARGIN, 28 + i * 6));

  const body = rows.map((r, i) => [
    String(i + 1), r.trackingNumber, r.flightReference ?? '—', r.clientReference ?? '—',
    `${Number(r.weightKg ?? 0).toFixed(2)} kg`, r.outcome ?? 'HANDED',
  ]);
  const totalWeight = rows.reduce((n, r) => n + Number(r.weightKg ?? 0), 0);

  autoTable(doc, {
    startY: 62,
    head: [['#', 'Tracking', 'Flight', 'Client ref', 'Weight', 'Outcome']],
    body,
    foot: [['', '', '', 'Total', `${totalWeight.toFixed(2)} kg`, `${rows.length} boxes`]],
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: NAVY },
    margin: { left: MARGIN, right: MARGIN },
  });

  const y = (doc.lastAutoTable?.finalY ?? 62) + 20;
  doc.setDrawColor(70, 70, 70);
  const half = (pageWidth - MARGIN * 2) / 2;
  doc.line(MARGIN, y, MARGIN + half - 8, y);
  doc.line(MARGIN + half + 8, y, pageWidth - MARGIN, y);
  doc.setFontSize(9);
  doc.text('Driver signature', MARGIN, y + 5);
  doc.text('Depot staff signature', MARGIN + half + 8, y + 5);

  return Buffer.from(doc.output('arraybuffer'));
};

module.exports = { renderHandoverManifestPdf };
