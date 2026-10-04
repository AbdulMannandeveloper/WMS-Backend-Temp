'use strict';

/**
 * The handover bench: dropping received boxes at a courier's depot.
 *
 * An operator opens a handover for one courier, scans received boxes of that
 * courier onto it, prints a manifest, and closes it at the depot with a photo of
 * the signed sheet. Closing marks every box HANDED_TO_COURIER — our
 * responsibility ends there. One handover may carry boxes from many flights and
 * many clients; each affected flight's status is recomputed on close.
 *
 * Every mutation locks the handover row and re-checks status='OPEN', so a scan
 * cannot land on a handover that close has already taken.
 */

const { prisma } = require('../lib/prisma');
const handoverRepository = require('../repositories/air_freight_handover.repository');
const boxRepository = require('../repositories/air_freight_box.repository');
const courierRepository = require('../repositories/courier.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const exceptionRepository = require('../repositories/air_freight_exception.repository');
const auditLogLogic = require('./audit_log.logic');
const { recomputeFlightStatus } = require('./air_freight_status');
const { notifyMilestone } = require('./air_freight_notifications');
const { normaliseTracking } = require('../utils/airFreightTracking');
const { parseUuid, buildListQuery, parseEnum, withScope } = require('../utils/queryFilters');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

const audit = (actor, action, details) => {
  if (!actor) return Promise.resolve(null);
  return auditLogLogic.createAuditLog(actor, action, details).catch((err) => console.error(`Audit (${action}):`, err.message));
};
const withStatus = (message, status) => { const e = new Error(message); e.status = status; return e; };
const lockHandover = async (id, tx) => {
  const rows = await tx.$queryRaw`SELECT status FROM air_freight_handovers WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw withStatus('Handover not found.', 404);
  return rows[0].status;
};
const event = (data, tx) => eventRepository.createEvent(data, tx);

// ─── Reference (HO-YYYY-NNNNNN) ───────────────────────────────────────────────────

const PREFIX = 'HO';
const DIGITS = 6;
const ATTEMPTS = 5;
const seriesFor = (d) => `${PREFIX}-${d.getUTCFullYear()}-`;

const nextReference = async (tx) => {
  const series = seriesFor(new Date());
  const recent = await handoverRepository.getLatestReferencesInSeries(series, 10, tx);
  let last = 0;
  for (const row of recent) {
    const tail = row.reference.slice(series.length);
    if (/^\d+$/.test(tail)) { last = Number.parseInt(tail, 10); break; }
  }
  return `${series}${String(last + 1).padStart(DIGITS, '0')}`;
};
const isRefClash = (e) => e?.code === 'P2002' && String(e.meta?.target ?? '').includes('reference');

// ─── Open ─────────────────────────────────────────────────────────────────────

const openHandover = async (data, actorUserId) => {
  const courierId = parseUuid(data.courierId, 'Courier');
  if (!courierId) throw new Error('A courier is required for a handover.');
  const courier = await courierRepository.getCourierById(courierId);
  if (!courier) throw withStatus('That courier does not exist.', 404);

  let depotId = null;
  let depotName = data.depotName ? String(data.depotName).trim() : '';
  if (data.depotId) {
    depotId = parseUuid(data.depotId, 'Depot');
    const depot = await courierRepository.getDepotById(depotId);
    if (!depot || depot.courierId !== courierId) throw withStatus('That depot is not on this courier.', 404);
    depotName = depotName || depot.name;
  }
  if (!depotName) throw new Error('Choose a depot or type its name.');

  for (let attempt = 1; ; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const reference = await nextReference(tx);
        return await handoverRepository.createHandover({
          reference, courierId, depotId, depotName,
          vehicleReg: data.vehicleReg ? String(data.vehicleReg).trim().slice(0, 20) : null,
          driverName: data.driverName ? String(data.driverName).trim().slice(0, 120) : null,
          status: 'OPEN', openedByUserId: actorUserId,
        }, tx);
      }, TRANSACTION_OPTIONS);
      await audit(actorUserId, 'AIR_FREIGHT_HANDOVER_OPENED', { handoverId: created.id, reference: created.reference, courierId });
      return created;
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRefClash(error)) throw error;
    }
  }
};

// ─── Scan onto / remove / refuse ────────────────────────────────────────────────

const scanHandover = async (handoverIdRaw, code, actorUserId) => {
  const handoverId = parseUuid(handoverIdRaw, 'Handover');
  if (!handoverId) throw withStatus('Handover not found.', 404);
  const tracking = normaliseTracking(code);
  if (!tracking) throw withStatus('That is not a tracking number.', 400);

  const result = await prisma.$transaction(async (tx) => {
    const status = await lockHandover(handoverId, tx);
    if (status !== 'OPEN') throw withStatus('This handover is closed.', 409);
    const handover = await handoverRepository.getHandoverById(handoverId, tx);

    const box = await boxRepository.findActiveByTracking(tracking, tx);
    if (!box) return { outcome: 'NOT_FOUND', message: `No active box for ${tracking}.` };
    if (box.handoverId === handoverId) return { outcome: 'ALREADY_ON', message: 'Already on this run.', box: { id: box.id, trackingNumber: box.trackingNumber } };
    if (box.courierId !== handover.courierId) return { outcome: 'WRONG_COURIER', message: `This is a ${box.courier?.code} box; this run is ${handover.courier?.code}.`, box: { id: box.id, trackingNumber: box.trackingNumber } };
    if (box.status === 'CUSTOMS_HOLD') return { outcome: 'CUSTOMS_HOLD', message: 'Held by customs.', box: { id: box.id, trackingNumber: box.trackingNumber } };
    if (box.status === 'ON_HOLD') return { outcome: 'ON_HOLD', message: 'On hold — resolve the exception first.', box: { id: box.id, trackingNumber: box.trackingNumber } };
    if (box.status === 'ON_HANDOVER') return { outcome: 'ON_OTHER_HANDOVER', message: 'Already on another open handover.', box: { id: box.id, trackingNumber: box.trackingNumber } };
    if (box.status !== 'RECEIVED') return { outcome: 'NOT_RECEIVED', message: `Not received (it is ${box.status.toLowerCase()}).`, box: { id: box.id, trackingNumber: box.trackingNumber } };

    const moved = await boxRepository.transitionIfStatus(box.id, ['RECEIVED'], { status: 'ON_HANDOVER', handoverId }, tx);
    if (moved === 0) return { outcome: 'NOT_RECEIVED', message: 'That box was just moved by someone else.', box: { id: box.id, trackingNumber: box.trackingNumber } };
    await event({ boxId: box.id, flightId: box.flightId, fromStatus: 'RECEIVED', toStatus: 'ON_HANDOVER', eventType: 'ADDED_TO_HANDOVER', source: 'SCAN', userId: actorUserId, note: handover.reference }, tx);
    await recomputeFlightStatus(box.flightId, tx);
    return { outcome: 'ADDED', message: `Added ${tracking}.`, box: { id: box.id, trackingNumber: box.trackingNumber } };
  }, TRANSACTION_OPTIONS);

  const fresh = await handoverRepository.getHandoverById(handoverId);
  return { ...result, count: fresh.boxes.filter((b) => b.status === 'ON_HANDOVER').length };
};

const removeBox = async (handoverIdRaw, boxIdRaw, actorUserId) => {
  const handoverId = parseUuid(handoverIdRaw, 'Handover');
  const boxId = parseUuid(boxIdRaw, 'Box');
  await prisma.$transaction(async (tx) => {
    const status = await lockHandover(handoverId, tx);
    if (status !== 'OPEN') throw withStatus('This handover is closed.', 409);
    const box = await boxRepository.getBoxById(boxId, tx);
    if (!box || box.handoverId !== handoverId) throw withStatus('That box is not on this handover.', 404);
    const moved = await boxRepository.transitionIfStatus(boxId, ['ON_HANDOVER'], { status: 'RECEIVED', handoverId: null }, tx);
    if (moved === 0) throw withStatus('That box is no longer on this handover.', 409);
    await event({ boxId, flightId: box.flightId, fromStatus: 'ON_HANDOVER', toStatus: 'RECEIVED', eventType: 'REMOVED_FROM_HANDOVER', source: 'MANUAL', userId: actorUserId }, tx);
    await recomputeFlightStatus(box.flightId, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_HANDOVER_BOX_REMOVED', { handoverId, boxId });
  return await handoverRepository.getHandoverById(handoverId);
};

const refuseBox = async (handoverIdRaw, boxIdRaw, { reason } = {}, actorUserId) => {
  const handoverId = parseUuid(handoverIdRaw, 'Handover');
  const boxId = parseUuid(boxIdRaw, 'Box');
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to refuse a box at the depot.');
  await prisma.$transaction(async (tx) => {
    const status = await lockHandover(handoverId, tx);
    if (status !== 'OPEN') throw withStatus('This handover is closed.', 409);
    const box = await boxRepository.getBoxById(boxId, tx);
    if (!box || box.handoverId !== handoverId) throw withStatus('That box is not on this handover.', 404);
    const moved = await boxRepository.transitionIfStatus(boxId, ['ON_HANDOVER'], { status: 'REFUSED_AT_DEPOT' }, tx);
    if (moved === 0) throw withStatus('That box is no longer on this handover.', 409);
    await event({ boxId, flightId: box.flightId, fromStatus: 'ON_HANDOVER', toStatus: 'REFUSED_AT_DEPOT', eventType: 'REFUSED_AT_DEPOT', source: 'MANUAL', userId: actorUserId, note: String(reason).trim() }, tx);
    await exceptionRepository.createException({ flightId: box.flightId, boxId, type: 'REFUSED_AT_DEPOT', status: 'OPEN', ownerRole: 'ADMIN', raisedByUserId: actorUserId, internalNote: String(reason).trim() }, tx);
    await recomputeFlightStatus(box.flightId, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_HANDOVER_BOX_REFUSED', { handoverId, boxId });
  return await handoverRepository.getHandoverById(handoverId);
};

// ─── Close / cancel ─────────────────────────────────────────────────────────────

const closeHandover = async (handoverIdRaw, { confirmedCount, depotStaffName, note, proofPhotoKey } = {}, actorUserId) => {
  const handoverId = parseUuid(handoverIdRaw, 'Handover');
  if (!handoverId) throw withStatus('Handover not found.', 404);
  if (!proofPhotoKey) throw new Error('A photo of the signed manifest is required to close a handover.');

  const affectedFlightIds = await prisma.$transaction(async (tx) => {
    const status = await lockHandover(handoverId, tx);
    if (status !== 'OPEN') throw withStatus('This handover is already closed.', 409);
    const handover = await handoverRepository.getHandoverById(handoverId, tx);
    const onRun = handover.boxes.filter((b) => b.status === 'ON_HANDOVER');
    const refused = handover.boxes.filter((b) => b.status === 'REFUSED_AT_DEPOT');

    const count = confirmedCount === undefined || confirmedCount === null ? onRun.length : Number(confirmedCount);
    if (!Number.isInteger(count) || count < 0) throw new Error('Confirmed count must be a whole number.');
    if (count !== onRun.length && !(note && String(note).trim())) {
      throw new Error('The confirmed count does not match — add a note explaining why.');
    }

    const now = new Date();
    const flightIds = new Set();
    for (const b of onRun) {
      await boxRepository.transitionIfStatus(b.id, ['ON_HANDOVER'], { status: 'HANDED_TO_COURIER', handedOverAt: now }, tx);
      await event({ boxId: b.id, flightId: b.flightId, fromStatus: 'ON_HANDOVER', toStatus: 'HANDED_TO_COURIER', eventType: 'HANDED_TO_COURIER', source: 'MANUAL', userId: actorUserId, note: handover.reference, photoKey: proofPhotoKey }, tx);
      flightIds.add(b.flightId);
    }
    for (const b of refused) flightIds.add(b.flightId);

    const boxSnapshot = [
      ...onRun.map((b) => ({ boxId: b.id, trackingNumber: b.trackingNumber, flightReference: b.flight?.reference, clientReference: b.clientReference, weightKg: Number(b.measuredWeightKg ?? b.declaredWeightKg), outcome: 'HANDED' })),
      ...refused.map((b) => ({ boxId: b.id, trackingNumber: b.trackingNumber, flightReference: b.flight?.reference, clientReference: b.clientReference, weightKg: Number(b.measuredWeightKg ?? b.declaredWeightKg), outcome: 'REFUSED' })),
    ];

    await handoverRepository.updateHandover(handoverId, {
      status: 'CLOSED', confirmedCount: count, depotStaffName: depotStaffName ? String(depotStaffName).trim() : null,
      closeNote: note ? String(note).trim() : null, proofPhotoKey, closedByUserId: actorUserId, closedAt: now, boxSnapshot,
    }, tx);

    for (const fid of flightIds) await recomputeFlightStatus(fid, tx);
    return [...flightIds];
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_HANDOVER_CLOSED', { handoverId });
  // A flight that completed on this close notifies the client (deduplicated).
  for (const fid of affectedFlightIds || []) {
    const f = await prisma.airFreightFlight.findUnique({ where: { id: fid }, select: { status: true } });
    if (f?.status === 'COMPLETED') await notifyMilestone(fid, 'COMPLETED');
  }
  return await handoverRepository.getHandoverById(handoverId);
};

const cancelHandover = async (handoverIdRaw, actorUserId) => {
  const handoverId = parseUuid(handoverIdRaw, 'Handover');
  if (!handoverId) throw withStatus('Handover not found.', 404);
  await prisma.$transaction(async (tx) => {
    const status = await lockHandover(handoverId, tx);
    if (status !== 'OPEN') throw withStatus('Only an open handover can be cancelled.', 409);
    const handover = await handoverRepository.getHandoverById(handoverId, tx);
    const flightIds = new Set();
    for (const b of handover.boxes.filter((x) => x.status === 'ON_HANDOVER')) {
      await boxRepository.transitionIfStatus(b.id, ['ON_HANDOVER'], { status: 'RECEIVED', handoverId: null }, tx);
      await event({ boxId: b.id, flightId: b.flightId, fromStatus: 'ON_HANDOVER', toStatus: 'RECEIVED', eventType: 'REMOVED_FROM_HANDOVER', source: 'MANUAL', userId: actorUserId }, tx);
      flightIds.add(b.flightId);
    }
    await handoverRepository.updateHandover(handoverId, { status: 'CANCELLED', cancelledAt: new Date() }, tx);
    for (const fid of flightIds) await recomputeFlightStatus(fid, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_HANDOVER_CANCELLED', { handoverId });
  return await handoverRepository.getHandoverById(handoverId);
};

// ─── Reads ──────────────────────────────────────────────────────────────────────

const getHandover = async (idRaw) => {
  const id = parseUuid(idRaw, 'Handover');
  if (!id) throw withStatus('Handover not found.', 404);
  const h = await handoverRepository.getHandoverById(id);
  if (!h) throw withStatus('Handover not found.', 404);
  return h;
};

const HANDOVER_LIST_SPEC = {
  filters: [
    (q) => { const s = parseEnum(q.status, ['OPEN', 'CLOSED', 'CANCELLED'], { label: 'status' }); return s ? { status: s } : undefined; },
    (q) => { const c = parseUuid(q.courierId, 'courierId'); return c ? { courierId: c } : undefined; },
  ],
  sort: { allowed: { openedAt: (o) => ({ openedAt: o }), reference: (o) => ({ reference: o }) }, defaultSort: { field: 'openedAt', order: 'desc' }, tiebreaker: [{ id: 'desc' }] },
};

const listHandovers = async (query) => {
  const { where, orderBy, pagination } = buildListQuery(query, HANDOVER_LIST_SPEC);
  return await handoverRepository.listHandovers(withScope(where, undefined), { orderBy, pagination });
};

/** Received-and-unhanded boxes across all flights, grouped by courier — the start of a run. */
const readyForHandoverSummary = async () => {
  const grouped = await prisma.airFreightBox.groupBy({ by: ['courierId'], where: { status: 'RECEIVED', handoverId: null }, _count: { _all: true } });
  const couriers = await courierRepository.listCouriers({ activeOnly: false });
  const byId = new Map(couriers.map((c) => [c.id, c]));
  return grouped.map((g) => ({ courierId: g.courierId, courier: byId.get(g.courierId) ? { id: g.courierId, code: byId.get(g.courierId).code, name: byId.get(g.courierId).name } : null, readyCount: g._count._all }));
};

module.exports = {
  openHandover, scanHandover, removeBox, refuseBox, closeHandover, cancelHandover,
  getHandover, listHandovers, readyForHandoverSummary, HANDOVER_LIST_SPEC,
};
