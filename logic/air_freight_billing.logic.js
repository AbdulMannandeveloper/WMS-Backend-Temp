'use strict';

/**
 * Air freight billing (Phase 7, after go-live).
 *
 * A flight becomes billable when it completes. The admin opens Billing, sees the
 * live statement (every line with its formula), and posts it to the client's
 * open monthly invoice. Posting freezes a snapshot; a POSTED flight shows what
 * was actually charged, not a recompute. Unposting removes the lines, unless any
 * sits on a PAID invoice (then a credit note is the remedy).
 *
 * The pure maths lives in utils/airFreightCharges; this layer only reads rates,
 * settings, boxes and exceptions, converts Decimals to numbers, and writes the
 * invoice lines.
 */

const { prisma } = require('../lib/prisma');
const flightRepository = require('../repositories/air_freight_flight.repository');
const invoiceLineItemRepository = require('../repositories/invoice_line_item.repository');
const monthlyInvoiceRepository = require('../repositories/monthly_invoice.repository');
const exceptionRepository = require('../repositories/air_freight_exception.repository');
const auditLogLogic = require('./audit_log.logic');
const { syncApprovedInvoicePdf } = require('./monthly_invoice.logic');
const { paidAmong, removeChargeLines } = require('./reversal');
const { getSettings } = require('./air_freight_settings.logic');
const { calculateFlightCharges } = require('../utils/airFreightCharges');
const { toCsv } = require('../utils/csvExport');
const { renderFlightBillingPdf } = require('../utils/airFreightBillingPdf');
const { parseUuid } = require('../utils/queryFilters');
const {
  getRateForClient,
  resolveOpenInvoiceFor,
  AIRFREIGHT_PER_KG_CODE,
  AIRFREIGHT_PER_BOX_CODE,
  AIRFREIGHT_STORAGE_CODE,
  AIRFREIGHT_DAMAGE_CODE,
  AIRFREIGHT_RELABEL_CODE,
} = require('./billing_services');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

const audit = (actor, action, details) => {
  if (!actor) return Promise.resolve(null);
  return auditLogLogic.createAuditLog(actor, action, details).catch((err) => console.error(`Audit (${action}):`, err.message));
};
const withStatus = (message, status) => { const e = new Error(message); e.status = status; return e; };

const CODE_BY_KEY = {
  perKg: AIRFREIGHT_PER_KG_CODE,
  perBox: AIRFREIGHT_PER_BOX_CODE,
  storage: AIRFREIGHT_STORAGE_CODE,
  damage: AIRFREIGHT_DAMAGE_CODE,
  relabel: AIRFREIGHT_RELABEL_CODE,
};

/** Reads the client's five rates. Returns { perKg: {unitPrice, clientService}|null, ... }. */
const loadRates = async (clientId, tx) => {
  const out = {};
  for (const [key, code] of Object.entries(CODE_BY_KEY)) {
    out[key] = await getRateForClient(clientId, code, tx);
  }
  return out;
};

const requireFlight = async (idRaw, tx) => {
  const id = parseUuid(idRaw, 'Flight');
  if (!id) throw withStatus('Flight not found.', 404);
  const flight = await flightRepository.getFlightById(id, tx);
  if (!flight) throw withStatus('Flight not found.', 404);
  return flight;
};

/** Boxes + exceptions a statement needs, shaped for the pure function. */
const loadInputs = async (flightId, tx) => {
  const client = tx || prisma;
  const [boxes, exceptions] = await Promise.all([
    client.airFreightBox.findMany({ where: { flightId } }),
    client.airFreightException.findMany({ where: { flightId } }),
  ]);
  return { boxes, exceptions };
};

/** Decimal rate → plain-number rate for the pure function. */
const pureRates = (rates) => {
  const out = {};
  for (const key of Object.keys(CODE_BY_KEY)) {
    out[key] = rates[key] ? { unitPrice: Number(rates[key].unitPrice) } : null;
  }
  return out;
};

const buildStatement = async (flight, tx) => {
  const [settings, { boxes, exceptions }, rates] = await Promise.all([
    getSettings(flight.clientId, tx),
    loadInputs(flight.id, tx),
    loadRates(flight.clientId, tx),
  ]);
  const statement = calculateFlightCharges({
    boxes,
    exceptions,
    rates: pureRates(rates),
    settings: { method: settings.chargeableWeightMethod, divisor: settings.volumetricDivisor, roundingIncrementKg: settings.roundingIncrementKg, freeStorageHours: settings.freeStorageHours },
    now: new Date(),
  });
  return { statement, settings, rates };
};

/**
 * The statement shown in Billing. POSTED flights return the frozen snapshot;
 * everything else returns a live computation.
 */
const getStatement = async (flightIdRaw) => {
  const flight = await requireFlight(flightIdRaw);
  if (flight.billingStatus === 'POSTED' && flight.billingSnapshot) {
    return { flight: { id: flight.id, reference: flight.reference, billingStatus: flight.billingStatus }, posted: true, ...flight.billingSnapshot };
  }
  const { statement, settings } = await buildStatement(flight);
  return {
    flight: { id: flight.id, reference: flight.reference, billingStatus: flight.billingStatus },
    posted: false,
    settings: { method: settings.chargeableWeightMethod, divisor: settings.volumetricDivisor, roundingIncrementKg: settings.roundingIncrementKg, freeStorageHours: settings.freeStorageHours },
    ...statement,
  };
};

const lineDescription = (flight, line) =>
  `Air freight ${flight.reference}${flight.mawbNumber ? ` (MAWB ${flight.mawbNumber})` : ''} — ${line.label.toLowerCase()}: ${line.quantity} ${line.unit}`.slice(0, 255);

/** Posts the statement to the client's open invoice (admin). */
const postCharges = async (flightIdRaw, actorUserId, { reason } = {}) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM air_freight_flights WHERE id = ${flightId}::uuid FOR UPDATE`;
    const flight = await flightRepository.getFlightById(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (flight.billingStatus === 'POSTED') throw withStatus('This flight is already posted.', 409);
    if (flight.status !== 'COMPLETED' && !(reason && String(reason).trim())) {
      throw new Error('This flight is not completed — posting it anyway needs a reason.');
    }

    const { statement, rates } = await buildStatement(flight, tx);
    if (statement.lines.length === 0) throw withStatus('There is nothing to charge (no agreed rates or no billable boxes).', 400);

    const invoice = await resolveOpenInvoiceFor(flight.clientId, tx);
    const dateOfService = flight.completedAt ?? new Date();
    for (const line of statement.lines) {
      const key = Object.keys(CODE_BY_KEY).find((k) => CODE_BY_KEY[k] === line.code);
      const clientServiceId = rates[key]?.clientService?.id;
      await invoiceLineItemRepository.createInvoiceLineItem({
        invoiceId: invoice.id,
        clientServiceId,
        airFreightFlightId: flight.id,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        totalPrice: line.total,
        description: lineDescription(flight, line),
        dateOfService,
        itemType: 'AIR_FREIGHT_CHARGE',
      }, tx);
    }
    await monthlyInvoiceRepository.recalculateInvoiceTotal(invoice.id, tx);

    const snapshot = { ...statement, invoiceId: invoice.id, postedAt: new Date().toISOString() };
    await flightRepository.updateFlight(flightId, {
      billingStatus: 'POSTED', billingPostedAt: new Date(), billingPostedByUserId: actorUserId,
      billingPostReason: reason ? String(reason).trim() : null, billingSnapshot: snapshot,
    }, tx);
    return { invoiceId: invoice.id, total: statement.totals.total };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_CHARGES_POSTED', { flightId, invoiceId: result.invoiceId, total: result.total });
  return await getStatement(flightId);
};

/** Removes posted charges (admin), unless any sits on a PAID invoice. */
const unpostCharges = async (flightIdRaw, actorUserId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  const touched = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM air_freight_flights WHERE id = ${flightId}::uuid FOR UPDATE`;
    const flight = await flightRepository.getFlightById(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (flight.billingStatus !== 'POSTED') throw withStatus('This flight is not posted.', 409);

    const lines = await tx.invoiceLineItem.findMany({
      where: { airFreightFlightId: flightId },
      select: { id: true, invoiceId: true, invoice: { select: { status: true } } },
    });
    if (paidAmong(lines).length > 0) {
      throw withStatus('Some charges are on a paid invoice — raise a credit note instead.', 409);
    }
    const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
    await removeChargeLines(lines, tx);
    for (const invoiceId of invoiceIds) await monthlyInvoiceRepository.recalculateInvoiceTotal(invoiceId, tx);

    await flightRepository.updateFlight(flightId, { billingStatus: 'READY', billingPostedAt: null, billingPostedByUserId: null, billingSnapshot: null }, tx);
    return lines.map((l) => ({ invoiceId: l.invoiceId, status: l.invoice?.status }));
  }, TRANSACTION_OPTIONS);

  // Re-sync any APPROVED invoice PDF after commit.
  const approved = [...new Set(touched.filter((t) => t.status === 'APPROVED').map((t) => t.invoiceId))];
  for (const id of approved) await syncApprovedInvoicePdf(id).catch((e) => console.error('[air-freight] pdf resync:', e.message));

  await audit(actorUserId, 'AIR_FREIGHT_CHARGES_UNPOSTED', { flightId });
  return await getStatement(flightId);
};

// ─── Exports (CSV / PDF) ────────────────────────────────────────────────────────

const breakdownCsv = async (flightIdRaw) => {
  const flight = await requireFlight(flightIdRaw);
  const data = await getStatement(flightIdRaw);
  const headers = ['line', 'quantity', 'unit', 'unit_price', 'total', 'formula'];
  const rows = (data.lines ?? []).map((l) => [l.label, l.quantity, l.unit, l.unitPrice, l.total, l.formula]);
  return { csv: toCsv(headers, rows), reference: flight.reference };
};

const breakdownPdf = async (flightIdRaw) => {
  const flight = await requireFlight(flightIdRaw);
  const data = await getStatement(flightIdRaw);
  return { buffer: renderFlightBillingPdf(flight, data), reference: flight.reference };
};

module.exports = { getStatement, postCharges, unpostCharges, breakdownCsv, breakdownPdf };
