'use strict';

/**
 * The receiving bench: scanning boxes in as a flight arrives, correcting weights,
 * flagging damage and label problems, holding/releasing a box at customs, and
 * closing the receipt (whatever was not scanned becomes SHORT).
 *
 * The scan endpoint never throws for a business outcome — a refusal is a 200
 * with an `outcome` the bench can read aloud, because the operator is holding a
 * scanner, not a debugger. Every state change is a conditional transition
 * (`transitionIfStatus`) plus an append-only event, so two benches on the same
 * flight cannot double-receive a box.
 */

const { prisma } = require('../lib/prisma');
const flightRepository = require('../repositories/air_freight_flight.repository');
const boxRepository = require('../repositories/air_freight_box.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const exceptionRepository = require('../repositories/air_freight_exception.repository');
const auditLogLogic = require('./audit_log.logic');
const { recomputeFlightStatus, RECEIVABLE_BOX_STATUSES } = require('./air_freight_status');
const { normaliseTracking } = require('../utils/airFreightTracking');
const { parseUuid } = require('../utils/queryFilters');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };
const RECEIVED_STATUSES = ['RECEIVED', 'ON_HOLD', 'ON_HANDOVER', 'HANDED_TO_COURIER', 'REFUSED_AT_DEPOT'];

const audit = (actor, action, details) => {
  if (!actor) return Promise.resolve(null);
  return auditLogLogic.createAuditLog(actor, action, details).catch((err) => console.error(`Audit (${action}):`, err.message));
};
const withStatus = (message, status) => { const e = new Error(message); e.status = status; return e; };
const lockFlight = async (id, tx) => { await tx.$queryRaw`SELECT id FROM air_freight_flights WHERE id = ${id}::uuid FOR UPDATE`; };
const event = (data, tx) => eventRepository.createEvent(data, tx);

// ─── Counters (returned with every scan) ────────────────────────────────────────

const buildCounters = async (flightId, tx) => {
  const client = tx || prisma;
  const [byStatus, byCourier, overCount] = await Promise.all([
    boxRepository.countsByStatus(flightId, tx),
    boxRepository.countsByCourier(flightId, tx),
    client.airFreightException.count({ where: { flightId, type: 'OVER', status: 'OPEN' } }),
  ]);
  const sum = (obj, keys) => keys.reduce((n, k) => n + (obj[k] ?? 0), 0);
  const allKeys = Object.keys(byStatus).filter((k) => k !== 'CANCELLED');
  const expected = sum(byStatus, allKeys);
  const received = sum(byStatus, RECEIVED_STATUSES);

  const courierMap = new Map();
  for (const row of byCourier) {
    if (row.status === 'CANCELLED') continue;
    const e = courierMap.get(row.courierId) || { courierId: row.courierId, expected: 0, received: 0 };
    e.expected += row._count._all;
    if (RECEIVED_STATUSES.includes(row.status)) e.received += row._count._all;
    courierMap.set(row.courierId, e);
  }

  return {
    expected,
    received,
    missing: Math.max(0, expected - received),
    over: overCount,
    byCourier: [...courierMap.values()],
  };
};

// ─── Scan (§1C) ─────────────────────────────────────────────────────────────────

const requireOpenFlight = async (flightId, tx) => {
  const flight = await flightRepository.getFlightCore(flightId, tx);
  if (!flight) throw withStatus('Flight not found.', 404);
  if (flight.status === 'DRAFT' || flight.status === 'CANCELLED') {
    throw withStatus('This flight is not open for receiving.', 400);
  }
  return flight;
};

const boxSummary = (box) => ({
  id: box.id, trackingNumber: box.trackingNumber, courierCode: box.courier?.code,
  status: box.status, reference: box.reference, clientReference: box.clientReference, receivedAt: box.receivedAt,
});

/** Auto-land a flight on its first receive, once, if it had not landed yet. */
const autoLandIfNeeded = async (flightId, actorUserId, tx) => {
  const flight = await flightRepository.getFlightCore(flightId, tx);
  if (flight.landedAt) return;
  const boxes = await boxRepository.findIdsByFlightAndStatus(flightId, ['DISPATCHED'], tx);
  if (boxes.length) {
    await boxRepository.transitionFlightBoxes(flightId, ['DISPATCHED'], { status: 'LANDED' }, tx);
    await eventRepository.createEvents(
      boxes.map((b) => ({ boxId: b.id, flightId, fromStatus: 'DISPATCHED', toStatus: 'LANDED', eventType: 'LANDED', source: 'SYSTEM', userId: actorUserId })), tx,
    );
  }
  await flightRepository.updateFlight(flightId, { landedAt: new Date(), landedByUserId: actorUserId }, tx);
};

const receiveScan = async (flightIdRaw, code, actorUserId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const tracking = normaliseTracking(code);
  if (!tracking) throw withStatus('That is not a tracking number.', 400);

  const outcome = await prisma.$transaction(async (tx) => {
    const flight = await requireOpenFlight(flightId, tx);
    const box = await boxRepository.findActiveByTracking(tracking, tx);

    if (box && box.flightId === flightId) {
      if (RECEIVABLE_BOX_STATUSES.includes(box.status)) {
        const moved = await boxRepository.transitionIfStatus(
          box.id, RECEIVABLE_BOX_STATUSES,
          { status: 'RECEIVED', receivedAt: new Date(), receivedByUserId: actorUserId }, tx,
        );
        if (moved === 1) {
          await event({ boxId: box.id, flightId, fromStatus: box.status, toStatus: 'RECEIVED', eventType: 'RECEIVED', source: 'SCAN', userId: actorUserId }, tx);
          await exceptionRepository.resolveOpenForBox(box.id, { status: 'RESOLVED', resolution: 'FOUND', resolvedByUserId: actorUserId, resolvedAt: new Date() }, tx);
          if (!flight.landedAt) { await lockFlight(flightId, tx); await autoLandIfNeeded(flightId, actorUserId, tx); }
          await recomputeFlightStatus(flightId, tx);
          const fresh = await boxRepository.getBoxById(box.id, tx);
          return { outcome: 'RECEIVED', message: `Received ${tracking} (${fresh.courier?.code}).`, box: boxSummary(fresh) };
        }
      }
      // Re-read for the non-receivable / already-done message.
      const fresh = await boxRepository.getBoxById(box.id, tx);
      switch (fresh.status) {
        case 'MANIFESTED': return { outcome: 'NOT_DISPATCHED', message: 'Flight not dispatched.', box: boxSummary(fresh) };
        case 'CUSTOMS_HOLD': return { outcome: 'CUSTOMS_HOLD', message: 'Held by customs.', box: boxSummary(fresh) };
        default: return { outcome: 'ALREADY_RECEIVED', message: `Already ${fresh.status.replace(/_/g, ' ').toLowerCase()}.`, box: boxSummary(fresh) };
      }
    }

    if (box) {
      return { outcome: 'OTHER_FLIGHT', message: `Belongs to ${box.flight?.reference ?? 'another flight'}.`, otherFlight: box.flight ? { id: box.flight.id, reference: box.flight.reference, mawbNumber: box.flight.mawbNumber } : undefined };
    }

    // Not active. A terminal box with this number on THIS flight gets a message.
    const terminal = await boxRepository.findAnyByTracking(tracking, tx);
    if (terminal && terminal.flightId === flightId) {
      if (terminal.status === 'WRITTEN_OFF') return { outcome: 'WRITTEN_OFF', message: 'Written off — admin override needed.', box: boxSummary(terminal) };
      if (terminal.status === 'CANCELLED') return { outcome: 'CANCELLED', message: 'This box was cancelled.', box: boxSummary(terminal) };
      return { outcome: 'ALREADY_RECEIVED', message: `Already ${terminal.status.replace(/_/g, ' ').toLowerCase()}.`, box: boxSummary(terminal) };
    }
    if (terminal) {
      return { outcome: 'OTHER_FLIGHT', message: `Belongs to ${terminal.flight?.reference ?? 'another flight'}.`, otherFlight: terminal.flight ? { id: terminal.flight.id, reference: terminal.flight.reference, mawbNumber: terminal.flight.mawbNumber } : undefined };
    }

    // Truly unknown → OVER. Lock the flight so two scans of the same code make one exception.
    await lockFlight(flightId, tx);
    let over = await exceptionRepository.findOpen({ flightId, type: 'OVER', scannedCode: tracking, statuses: ['OPEN'] }, tx);
    if (!over) {
      over = await exceptionRepository.createException(
        { flightId, type: 'OVER', status: 'OPEN', ownerRole: 'ADMIN', scannedCode: tracking, raisedByUserId: actorUserId }, tx,
      );
    }
    return { outcome: 'OVER', message: `Not on any manifest — set aside (${tracking}).`, exceptionId: over.id };
  }, TRANSACTION_OPTIONS);

  const counters = await buildCounters(flightId);
  return { ...outcome, counters };
};

// ─── Box actions ────────────────────────────────────────────────────────────────

const requireBox = async (idRaw, tx) => {
  const id = parseUuid(idRaw, 'Box');
  if (!id) throw withStatus('Box not found.', 404);
  const box = await boxRepository.getBoxById(id, tx);
  if (!box) throw withStatus('Box not found.', 404);
  return box;
};

const receiveManually = async (boxIdRaw, actorUserId) => {
  const box = await requireBox(boxIdRaw);
  await prisma.$transaction(async (tx) => {
    const moved = await boxRepository.transitionIfStatus(box.id, RECEIVABLE_BOX_STATUSES, { status: 'RECEIVED', receivedAt: new Date(), receivedByUserId: actorUserId }, tx);
    if (moved === 0) throw withStatus(`This box is ${box.status.toLowerCase()}, not awaiting receipt.`, 409);
    await event({ boxId: box.id, flightId: box.flightId, fromStatus: box.status, toStatus: 'RECEIVED', eventType: 'RECEIVED', source: 'MANUAL', userId: actorUserId }, tx);
    await exceptionRepository.resolveOpenForBox(box.id, { status: 'RESOLVED', resolution: 'FOUND', resolvedByUserId: actorUserId, resolvedAt: new Date() }, tx);
    if (!(await flightRepository.getFlightCore(box.flightId, tx)).landedAt) { await lockFlight(box.flightId, tx); await autoLandIfNeeded(box.flightId, actorUserId, tx); }
    await recomputeFlightStatus(box.flightId, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_BOX_RECEIVED_MANUAL', { boxId: box.id });
  return await boxRepository.getBoxById(box.id);
};

const toNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

const recordMeasurements = async (boxIdRaw, data, actorUserId) => {
  const box = await requireBox(boxIdRaw);
  const patch = { measuredByUserId: actorUserId, measuredAt: new Date() };
  if ('weightKg' in data) patch.measuredWeightKg = toNum(data.weightKg);
  if ('lengthCm' in data) patch.measuredLengthCm = toNum(data.lengthCm);
  if ('widthCm' in data) patch.measuredWidthCm = toNum(data.widthCm);
  if ('heightCm' in data) patch.measuredHeightCm = toNum(data.heightCm);
  await prisma.$transaction(async (tx) => {
    await boxRepository.updateBox(box.id, patch, tx);
    await event({ boxId: box.id, flightId: box.flightId, fromStatus: box.status, toStatus: box.status, eventType: 'MEASURED', source: 'MANUAL', userId: actorUserId }, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_BOX_MEASURED', { boxId: box.id });
  return await boxRepository.getBoxById(box.id);
};

/** Damage or label problem: box → ON_HOLD, exception AWAITING_CLIENT. */
const raiseHoldException = async (boxIdRaw, type, { note, photoKey } = {}, actorUserId) => {
  const box = await requireBox(boxIdRaw);
  const result = await prisma.$transaction(async (tx) => {
    const moved = await boxRepository.transitionIfStatus(box.id, ['RECEIVED'], { status: 'ON_HOLD' }, tx);
    if (moved === 0) throw withStatus('Only a received box can be put on hold.', 409);
    await event({ boxId: box.id, flightId: box.flightId, fromStatus: 'RECEIVED', toStatus: 'ON_HOLD', eventType: 'ON_HOLD', source: 'MANUAL', userId: actorUserId, note: note ?? null, photoKey: photoKey ?? null }, tx);
    const exc = await exceptionRepository.createException(
      { flightId: box.flightId, boxId: box.id, type, status: 'AWAITING_CLIENT', ownerRole: 'CLIENT', raisedByUserId: actorUserId, internalNote: note ?? null, photoKey: photoKey ?? null }, tx,
    );
    await recomputeFlightStatus(box.flightId, tx);
    return exc;
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_EXCEPTION_RAISED', { boxId: box.id, type });
  return result;
};

const raiseDamage = (boxId, data, actor) => raiseHoldException(boxId, 'DAMAGED', data, actor);
const raiseLabelIssue = (boxId, data, actor) => raiseHoldException(boxId, 'LABEL_UNREADABLE', data, actor);

/** Box-level customs hold / release. */
const holdBox = async (boxIdRaw, { note } = {}, actorUserId) => {
  const box = await requireBox(boxIdRaw);
  await prisma.$transaction(async (tx) => {
    const from = box.status;
    const moved = await boxRepository.transitionIfStatus(box.id, ['LANDED', 'CLEARED', 'RECEIVED'], { status: 'CUSTOMS_HOLD', statusBeforeHold: from, holdScope: 'BOX' }, tx);
    if (moved === 0) throw withStatus('This box cannot be held from its current state.', 409);
    await event({ boxId: box.id, flightId: box.flightId, fromStatus: from, toStatus: 'CUSTOMS_HOLD', eventType: 'CUSTOMS_HOLD', source: 'MANUAL', userId: actorUserId, note: note ?? null }, tx);
    await recomputeFlightStatus(box.flightId, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_BOX_CUSTOMS_HOLD', { boxId: box.id });
  return await boxRepository.getBoxById(box.id);
};

const releaseBox = async (boxIdRaw, actorUserId) => {
  const box = await requireBox(boxIdRaw);
  if (box.status !== 'CUSTOMS_HOLD' || box.holdScope !== 'BOX') {
    throw withStatus('This box is not under a box-level customs hold.', 409);
  }
  const back = box.statusBeforeHold || 'LANDED';
  await prisma.$transaction(async (tx) => {
    const moved = await boxRepository.transitionIfStatus(box.id, ['CUSTOMS_HOLD'], { status: back, statusBeforeHold: null, holdScope: null }, tx);
    if (moved === 0) throw withStatus('This box is no longer held.', 409);
    await event({ boxId: box.id, flightId: box.flightId, fromStatus: 'CUSTOMS_HOLD', toStatus: back, eventType: 'CLEARED', source: 'MANUAL', userId: actorUserId }, tx);
    await recomputeFlightStatus(box.flightId, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_BOX_CUSTOMS_RELEASE', { boxId: box.id });
  return await boxRepository.getBoxById(box.id);
};

// ─── Close / reopen receipt ───────────────────────────────────────────────────

const closeReceipt = async (flightIdRaw, actorUserId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  const result = await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (!flight.landedAt) throw new Error('The flight has not landed yet.');
    if (flight.receiptClosedAt) throw withStatus('The receipt is already closed.', 409);

    const short = await boxRepository.findIdsByFlightAndStatus(flightId, ['DISPATCHED', 'LANDED', 'CLEARED'], tx);
    if (short.length) {
      await boxRepository.transitionFlightBoxes(flightId, ['DISPATCHED', 'LANDED', 'CLEARED'], { status: 'SHORT' }, tx);
      await eventRepository.createEvents(short.map((b) => ({ boxId: b.id, flightId, fromStatus: b.status, toStatus: 'SHORT', eventType: 'SHORT', source: 'SYSTEM', userId: actorUserId })), tx);
      await tx.airFreightException.createMany({
        data: short.map((b) => ({ flightId, boxId: b.id, type: 'SHORT', status: 'OPEN', ownerRole: 'ADMIN', raisedByUserId: actorUserId })),
      });
    }
    await flightRepository.updateFlight(flightId, { receiptClosedAt: new Date(), receiptClosedByUserId: actorUserId }, tx);
    await recomputeFlightStatus(flightId, tx);
    return { short: short.length };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_RECEIPT_CLOSED', { flightId, short: result.short });
  return await flightRepository.getFlightById(flightId);
};

const reopenReceipt = async (flightIdRaw, { reason } = {}, actorUserId) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to reopen a receipt.');
  await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (!flight.receiptClosedAt) throw withStatus('The receipt is not closed.', 409);
    await flightRepository.updateFlight(flightId, { receiptClosedAt: null, receiptClosedByUserId: null, completedAt: null }, tx);
    await recomputeFlightStatus(flightId, tx);
  }, TRANSACTION_OPTIONS);
  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_RECEIPT_REOPENED', { flightId, reason: String(reason).trim() });
  return await flightRepository.getFlightById(flightId);
};

// ─── Sort view ────────────────────────────────────────────────────────────────

/** Received boxes not yet on a handover, grouped by courier. */
const sortSummary = async (flightIdRaw) => {
  const flightId = parseUuid(flightIdRaw, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const grouped = await prisma.airFreightBox.groupBy({
    by: ['courierId'], where: { flightId, status: 'RECEIVED', handoverId: null }, _count: { _all: true },
  });
  const couriers = await prisma.courier.findMany({ where: { id: { in: grouped.map((g) => g.courierId) } }, select: { id: true, code: true, name: true } });
  const byId = new Map(couriers.map((c) => [c.id, c]));
  return grouped.map((g) => ({ courierId: g.courierId, courier: byId.get(g.courierId), readyCount: g._count._all }));
};

module.exports = {
  receiveScan, receiveManually, recordMeasurements, raiseDamage, raiseLabelIssue,
  holdBox, releaseBox, closeReceipt, reopenReceipt, sortSummary, buildCounters,
};
