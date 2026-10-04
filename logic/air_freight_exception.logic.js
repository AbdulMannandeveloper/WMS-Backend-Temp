'use strict';

/**
 * Exceptions and their resolutions, plus the client's decision in the portal.
 *
 * Each exception type allows a small set of resolutions (ALLOWED_RESOLUTIONS),
 * and each resolution moves the box the matching way: a found short is received,
 * a damaged box ships as-is or is returned, an over box is added to the manifest
 * as a received box, a relabelled box gets its new tracking number (the old one
 * kept). Hub staff may resolve only the operational ones; anything a client has
 * a say in waits AWAITING_CLIENT until the client decides or an admin acts for
 * them.
 */

const { prisma } = require('../lib/prisma');
const exceptionRepository = require('../repositories/air_freight_exception.repository');
const boxRepository = require('../repositories/air_freight_box.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const auditLogLogic = require('./audit_log.logic');
const { recomputeFlightStatus } = require('./air_freight_status');
const { normaliseTracking } = require('../utils/airFreightTracking');
const { toCsv } = require('../utils/csvExport');
const { parseUuid, buildListQuery, parseEnum, withScope } = require('../utils/queryFilters');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };
const WRITE_OFF_AGE_DAYS = 7;

const audit = (actor, action, details) => {
  if (!actor) return Promise.resolve(null);
  return auditLogLogic.createAuditLog(actor, action, details).catch((err) => console.error(`Audit (${action}):`, err.message));
};
const withStatus = (message, status) => { const e = new Error(message); e.status = status; return e; };
const event = (data, tx) => eventRepository.createEvent(data, tx);

const ALLOWED_RESOLUTIONS = {
  SHORT: ['FOUND', 'WRITTEN_OFF'],
  OVER: ['ADDED_TO_MANIFEST', 'RETURNED_TO_CLIENT'],
  DAMAGED: ['SHIPPED_AS_IS', 'RETURNED_TO_CLIENT'],
  LABEL_UNREADABLE: ['RELABELLED', 'RETURNED_TO_CLIENT'],
  WRONG_COURIER: ['RELABELLED', 'RETURNED_TO_CLIENT'],
  CUSTOMS_HOLD: ['RELEASED'],
  REFUSED_AT_DEPOT: ['REPACKED', 'RETURNED_TO_CLIENT'],
};

const HUB_ALLOWED = new Set(['RELABELLED', 'REPACKED', 'RELEASED', 'SHIPPED_AS_IS']);
const CLIENT_DECISIONS = ['SHIP_AS_IS', 'HOLD', 'RETURN', 'NEW_LABEL'];

// ─── Reads ────────────────────────────────────────────────────────────────────

const scopeClause = (scopeClientId) => (scopeClientId ? { flight: { clientId: scopeClientId } } : undefined);

const AIR_FREIGHT_EXCEPTION_LIST_SPEC = {
  filters: [
    (q) => { const s = parseEnum(q.status, ['OPEN', 'AWAITING_CLIENT', 'RESOLVED'], { label: 'status' }); return s ? { status: s } : undefined; },
    (q) => { const t = parseEnum(q.type, Object.keys(ALLOWED_RESOLUTIONS), { label: 'type' }); return t ? { type: t } : undefined; },
    (q) => { const f = parseUuid(q.flightId, 'flightId'); return f ? { flightId: f } : undefined; },
  ],
  sort: { allowed: { raisedAt: (o) => ({ raisedAt: o }), status: (o) => ({ status: o }) }, defaultSort: { field: 'raisedAt', order: 'desc' }, tiebreaker: [{ id: 'desc' }] },
};

const listExceptions = async (query, scopeClientId) => {
  const { where, orderBy, pagination } = buildListQuery(query, AIR_FREIGHT_EXCEPTION_LIST_SPEC);
  const scoped = withScope(where, scopeClause(scopeClientId));
  const [items, total] = await Promise.all([
    prisma.airFreightException.findMany({ where: scoped, include: exceptionRepository.includeRelations, orderBy, skip: pagination.skip, take: pagination.take }),
    prisma.airFreightException.count({ where: scoped }),
  ]);
  return { items, total };
};

const summary = async (scopeClientId) => {
  const scoped = withScope({ status: { in: ['OPEN', 'AWAITING_CLIENT'] } }, scopeClause(scopeClientId));
  const open = await prisma.airFreightException.findMany({ where: scoped, select: { raisedAt: true, type: true } });
  const now = Date.now();
  const buckets = { under24h: 0, h24to48: 0, over48h: 0 };
  let eligibleForWriteOff = 0;
  for (const e of open) {
    const ageH = (now - new Date(e.raisedAt).getTime()) / 3_600_000;
    if (ageH < 24) buckets.under24h += 1;
    else if (ageH < 48) buckets.h24to48 += 1;
    else buckets.over48h += 1;
    if (e.type === 'SHORT' && ageH >= WRITE_OFF_AGE_DAYS * 24) eligibleForWriteOff += 1;
  }
  return { total: open.length, buckets, eligibleForWriteOff };
};

/** An exception with its box details attached (boxId is a plain FK). */
const getException = async (idRaw, scopeClientId) => {
  const id = parseUuid(idRaw, 'Exception');
  if (!id) throw withStatus('Exception not found.', 404);
  const exc = await exceptionRepository.getExceptionById(id);
  if (!exc) throw withStatus('Exception not found.', 404);
  if (scopeClientId && exc.flight.clientId !== scopeClientId) throw withStatus('Exception not found.', 404);
  const box = exc.boxId ? await boxRepository.getBoxById(exc.boxId) : null;
  return { ...exc, box };
};

// ─── Resolve ────────────────────────────────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

const createOverBox = async (exc, boxData, actorUserId, tx) => {
  const tracking = normaliseTracking(boxData.trackingNumber);
  if (!tracking) throw new Error('A valid tracking number is required to add this box.');
  const courierId = parseUuid(boxData.courierId, 'Courier');
  if (!courierId) throw new Error('A courier is required to add this box.');
  const required = { declaredWeightKg: num(boxData.weightKg ?? boxData.declaredWeightKg), lengthCm: num(boxData.lengthCm), widthCm: num(boxData.widthCm), heightCm: num(boxData.heightCm), declaredValue: num(boxData.declaredValue) };
  for (const [k, v] of Object.entries(required)) if (v === null) throw new Error(`${k} must be a positive number.`);

  const created = await tx.airFreightBox.create({
    data: {
      flightId: exc.flightId, courierId, trackingNumber: tracking,
      clientReference: boxData.clientReference ? String(boxData.clientReference).slice(0, 80) : null,
      reference: boxData.reference ? String(boxData.reference).slice(0, 80) : null,
      declaredWeightKg: required.declaredWeightKg, lengthCm: required.lengthCm, widthCm: required.widthCm, heightCm: required.heightCm,
      contentsDescription: String(boxData.contentsDescription || 'Over box').slice(0, 255),
      hsCode: boxData.hsCode ? String(boxData.hsCode).slice(0, 10) : null,
      declaredValue: required.declaredValue, currency: String(boxData.currency || 'GBP').toUpperCase().slice(0, 3),
      consigneeName: String(boxData.consigneeName || '—').slice(0, 160), consigneePostcode: String(boxData.consigneePostcode || '—').slice(0, 20),
      status: 'RECEIVED', receivedAt: exc.raisedAt, receivedByUserId: exc.raisedByUserId,
    },
  });
  await event({ boxId: created.id, flightId: exc.flightId, fromStatus: null, toStatus: 'MANIFESTED', eventType: 'MANIFESTED', source: 'MANUAL', userId: actorUserId }, tx);
  await event({ boxId: created.id, flightId: exc.flightId, fromStatus: 'MANIFESTED', toStatus: 'RECEIVED', eventType: 'RECEIVED', source: 'MANUAL', userId: actorUserId, note: 'Added from OVER exception' }, tx);
  return created;
};

const applyBoxResolution = async (exc, resolution, data, actorUserId, tx) => {
  const now = new Date();
  if (resolution === 'ADDED_TO_MANIFEST') {
    const box = await createOverBox(exc, data.boxData || {}, actorUserId, tx);
    return { boxId: box.id };
  }
  if (!exc.boxId) return {};
  const box = await boxRepository.getBoxById(exc.boxId, tx);
  if (!box) return {};

  const move = async (from, to, extra = {}) => {
    const moved = await boxRepository.transitionIfStatus(exc.boxId, Array.isArray(from) ? from : [from], { status: to, ...extra }, tx);
    if (moved) await event({ boxId: exc.boxId, flightId: exc.flightId, fromStatus: box.status, toStatus: to, eventType: resolution, source: 'MANUAL', userId: actorUserId }, tx);
  };

  switch (resolution) {
    case 'WRITTEN_OFF': await move('SHORT', 'WRITTEN_OFF', { writtenOffAt: now }); break;
    case 'SHIPPED_AS_IS': await move(['ON_HOLD', 'RECEIVED'], 'RECEIVED'); break;
    case 'REPACKED': await move('REFUSED_AT_DEPOT', 'RECEIVED', { handoverId: null }); break;
    case 'RELEASED': await move('CUSTOMS_HOLD', box.statusBeforeHold || 'LANDED', { statusBeforeHold: null, holdScope: null }); break;
    case 'RETURNED_TO_CLIENT': await move(['ON_HOLD', 'REFUSED_AT_DEPOT', 'RECEIVED'], 'RETURNED_TO_CLIENT', { returnedAt: now }); break;
    case 'RELABELLED': {
      const extra = {};
      const newTracking = data.newTrackingNumber ? normaliseTracking(data.newTrackingNumber) : null;
      if (newTracking && newTracking !== box.trackingNumber) {
        extra.trackingNumber = newTracking;
        extra.previousTrackingNumbers = [...(box.previousTrackingNumbers || []), box.trackingNumber];
      }
      if (data.newCourierId) { const c = parseUuid(data.newCourierId, 'Courier'); if (c) extra.courierId = c; }
      try {
        await move(['ON_HOLD', 'RECEIVED'], 'RECEIVED', extra);
      } catch (e) {
        if (e?.code === 'P2002') throw withStatus('That new tracking number is already on another active box.', 409);
        throw e;
      }
      break;
    }
    default: break;
  }
  return {};
};

/**
 * Resolves an exception. `actorRole` gates hub staff to the operational
 * resolutions; while AWAITING_CLIENT only an admin may act (for the client).
 */
const resolve = async (idRaw, data, actorUserId, actorRole) => {
  const id = parseUuid(idRaw, 'Exception');
  if (!id) throw withStatus('Exception not found.', 404);
  const { resolution } = data;

  const result = await prisma.$transaction(async (tx) => {
    const exc = await exceptionRepository.getExceptionById(id, tx);
    if (!exc) throw withStatus('Exception not found.', 404);
    if (exc.status === 'RESOLVED') throw withStatus('This exception is already resolved.', 409);

    const allowed = ALLOWED_RESOLUTIONS[exc.type] || [];
    if (!allowed.includes(resolution)) throw new Error(`A ${exc.type} exception cannot be resolved as ${resolution}.`);

    if (actorRole && actorRole !== 'admin') {
      if (!HUB_ALLOWED.has(resolution)) throw withStatus('Only an admin can resolve this exception that way.', 403);
      if (exc.status === 'AWAITING_CLIENT') throw withStatus('This is waiting on the client — only an admin may act for them.', 403);
    }

    const { boxId } = await applyBoxResolution(exc, resolution, data, actorUserId, tx);

    const updated = await exceptionRepository.updateException(id, {
      status: 'RESOLVED', resolution, resolvedByUserId: actorUserId, resolvedAt: new Date(),
      internalNote: data.internalNote ?? exc.internalNote, clientNote: data.clientNote ?? exc.clientNote,
      chargeable: data.chargeable !== undefined ? Boolean(data.chargeable) : exc.chargeable,
      ...(boxId ? { boxId } : {}),
    }, tx);
    await recomputeFlightStatus(exc.flightId, tx);
    return updated;
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_EXCEPTION_RESOLVED', { exceptionId: id, resolution });
  return await getException(id);
};

// ─── Client decision ────────────────────────────────────────────────────────────

const recordClientDecision = async (idRaw, data, scopeClientId, actorUserId) => {
  const id = parseUuid(idRaw, 'Exception');
  if (!id) throw withStatus('Exception not found.', 404);
  const decision = data.decision;
  if (!CLIENT_DECISIONS.includes(decision)) throw new Error('Choose ship as-is, hold, return, or new label.');

  const exc = await exceptionRepository.getExceptionById(id);
  if (!exc) throw withStatus('Exception not found.', 404);
  if (scopeClientId && exc.flight.clientId !== scopeClientId) throw withStatus('Exception not found.', 404);
  if (!['DAMAGED', 'LABEL_UNREADABLE', 'WRONG_COURIER'].includes(exc.type)) {
    throw withStatus('This exception does not take a client decision.', 409);
  }
  if (exc.status === 'RESOLVED') throw withStatus('This exception is already resolved.', 409);

  const updated = await exceptionRepository.updateException(id, {
    clientDecision: decision, clientDecisionNote: data.note ? String(data.note).slice(0, 2000) : null,
    clientDecidedAt: new Date(), clientLabelKey: data.labelKey ?? null,
    // The decision is recorded; staff still act on it, so the exception reopens to OPEN.
    status: 'OPEN',
  });
  await audit(actorUserId, 'AIR_FREIGHT_CLIENT_DECISION', { exceptionId: id, decision });
  return updated;
};

// ─── Export ──────────────────────────────────────────────────────────────────

const exportCsv = async (query, scopeClientId) => {
  const { items } = await listExceptions({ ...query, limit: 10_000, page: 1 }, scopeClientId);
  const headers = ['flight', 'type', 'status', 'raised_at', 'resolution', 'scanned_code', 'client_decision'];
  const rows = items.map((e) => [e.flight?.reference ?? '', e.type, e.status, e.raisedAt.toISOString?.() ?? String(e.raisedAt), e.resolution ?? '', e.scannedCode ?? '', e.clientDecision ?? '']);
  return toCsv(headers, rows);
};

module.exports = {
  listExceptions, summary, getException, resolve, recordClientDecision, exportCsv,
  AIR_FREIGHT_EXCEPTION_LIST_SPEC, ALLOWED_RESOLUTIONS,
};
