'use strict';

/**
 * Air freight flights — the consolidation a client books, the boxes travel on,
 * and our hub receives against.
 *
 * A flight is created in DRAFT, filled with boxes from one or more manifest
 * uploads, then dispatched — at which point its box list is locked and the
 * boxes begin their journey. Everything about who may do what (staff vs the
 * client's own portal) is enforced at the route and controller; this layer
 * assumes the caller is allowed and the clientId has already been resolved.
 *
 * The reference (AF-YYYY-NNNNNN) and the box-status machine are worked out here,
 * not typed in, for the same reason every other module generates its own: a
 * number keyed at a desk is a number keyed wrong eventually.
 */

const { prisma } = require('../lib/prisma');
const flightRepository = require('../repositories/air_freight_flight.repository');
const boxRepository = require('../repositories/air_freight_box.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const exceptionRepository = require('../repositories/air_freight_exception.repository');
const auditLogLogic = require('./audit_log.logic');
const { recomputeFlightStatus, TERMINAL_BOX_STATUSES } = require('./air_freight_status');
const { normaliseMawb } = require('../utils/airFreightTracking');
const {
  buildListQuery,
  parseEnum,
  searchFilter,
  dateRangeFilter,
  parseUuid,
  withScope,
} = require('../utils/queryFilters');
const { buildReport, assertDeletable, lockForDelete } = require('../utils/dependents');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

const FLIGHT_STATUSES = [
  'DRAFT', 'DISPATCHED', 'LANDED', 'CUSTOMS_HOLD', 'CLEARED', 'RECEIVING',
  'RECEIVED', 'RECEIVED_PARTIAL', 'IN_DELIVERY', 'COMPLETED', 'CANCELLED',
];

const audit = (actorUserId, action, details) => {
  if (!actorUserId) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actorUserId, action, details)
    .catch((err) => console.error(`Audit log error (${action}):`, err.message));
};

const withStatus = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const lockFlight = async (id, tx) => {
  await tx.$queryRaw`SELECT id FROM air_freight_flights WHERE id = ${id}::uuid FOR UPDATE`;
};

// ─── The flight reference ───────────────────────────────────────────────────────

const REFERENCE_PREFIX = 'AF';
const REFERENCE_DIGITS = 6;
const REFERENCE_ATTEMPTS = 5;
const REFERENCE_SCAN = 10;

const referenceSeriesFor = (date) => `${REFERENCE_PREFIX}-${date.getUTCFullYear()}-`;

const nextFlightReference = async (tx) => {
  const series = referenceSeriesFor(new Date());
  const recent = await flightRepository.getLatestReferencesInSeries(series, REFERENCE_SCAN, tx);

  let last = 0;
  for (const row of recent) {
    const tail = row.reference.slice(series.length);
    if (!/^\d+$/.test(tail)) continue;
    last = Number.parseInt(tail, 10);
    break;
  }
  return `${series}${String(last + 1).padStart(REFERENCE_DIGITS, '0')}`;
};

const isReferenceClash = (error) => {
  if (error?.code !== 'P2002') return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((f) => String(f ?? '').includes('reference'));
};

// ─── Input coercion ─────────────────────────────────────────────────────────────

const trimTo = (raw, max, label, { required = false } = {}) => {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!value) {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (value.length > max) throw new Error(`${label} is too long — ${max} characters maximum.`);
  return value;
};

const parseDateOrNull = (raw, label) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const date = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid date and time.`);
  return date;
};

const parsePieces = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error('Declared pieces must be a whole number of zero or more.');
  if (n > 1_000_000) throw new Error('Declared pieces is implausibly large.');
  return n;
};

const parseWeight = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error('Declared weight must be zero or more.');
  return n;
};

/** The MAWB stored, plus whether its check digit verified (a warning, never a block). */
const coerceMawb = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null, checkDigitOk: true };
  }
  const { value, checkDigitOk } = normaliseMawb(raw);
  if (!value) throw new Error('That master air waybill has no digits in it.');
  if (value.length > 20) throw new Error('That master air waybill is too long.');
  return { value, checkDigitOk };
};

/** The editable header fields, used by both create and the DRAFT edit. */
const buildHeaderPatch = (data, { forCreate = false } = {}) => {
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);

  if (forCreate || has('originLocation')) {
    patch.originLocation = trimTo(data.originLocation, 120, 'Origin', { required: forCreate });
  }
  if (forCreate || has('destinationLocation')) {
    patch.destinationLocation = trimTo(data.destinationLocation, 120, 'Destination', { required: forCreate });
  }
  if (has('mawbNumber')) patch.mawbNumber = coerceMawb(data.mawbNumber).value;
  if (has('airline')) patch.airline = trimTo(data.airline, 80, 'Airline');
  if (has('flightNumber')) patch.flightNumber = trimTo(data.flightNumber, 20, 'Flight number');
  if (has('etd')) patch.etd = parseDateOrNull(data.etd, 'ETD');
  if (has('eta')) patch.eta = parseDateOrNull(data.eta, 'ETA');
  if (has('declaredPieces')) patch.declaredPieces = parsePieces(data.declaredPieces);
  if (has('declaredWeightKg')) patch.declaredWeightKg = parseWeight(data.declaredWeightKg);
  if (has('notes')) patch.notes = trimTo(data.notes, 10_000, 'Notes');

  return patch;
};

// ─── Create ─────────────────────────────────────────────────────────────────────

/**
 * Creates a DRAFT flight for a client. `clientId` is resolved by the caller
 * (forced to the client's own id in the portal), so it is trusted here.
 */
const createFlight = async (data, actorUserId) => {
  const clientId = parseUuid(data.clientId, 'Client');
  if (!clientId) throw new Error('A client is required for a flight.');

  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw withStatus('That client does not exist.', 404);

  const patch = buildHeaderPatch(data, { forCreate: true });
  const mawb = coerceMawb(data.mawbNumber);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const reference = await nextFlightReference(tx);
        return await flightRepository.createFlight(
          { ...patch, reference, clientId, status: 'DRAFT', createdByUserId: actorUserId },
          tx,
        );
      }, TRANSACTION_OPTIONS);

      await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_CREATED', {
        flightId: created.id,
        reference: created.reference,
        clientId,
      });
      return { ...created, mawbCheckDigitOk: mawb.checkDigitOk };
    } catch (error) {
      if (attempt >= REFERENCE_ATTEMPTS || !isReferenceClash(error)) throw error;
    }
  }
};

// ─── Edit ───────────────────────────────────────────────────────────────────────

/**
 * Edits a flight's header. A DRAFT may be edited freely; after dispatch the box
 * list is locked and only the header may change, with a reason — the route
 * restricts that to an admin, this layer requires the reason and records it.
 */
const updateFlight = async (id, data, actorUserId, { afterDispatchReason, actorRole } = {}) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  const flight = await flightRepository.getFlightCore(flightId);
  if (!flight) throw withStatus('Flight not found.', 404);

  const patch = buildHeaderPatch(data);
  if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

  const isDraft = flight.status === 'DRAFT';
  if (!isDraft) {
    if (flight.status === 'CANCELLED' || flight.status === 'COMPLETED') {
      throw withStatus(`A ${flight.status.toLowerCase()} flight cannot be edited.`, 409);
    }
    // After dispatch the box list is locked and only an admin may touch the
    // header, with a reason — a client or employee cannot.
    if (actorRole && actorRole !== 'admin') {
      throw withStatus('Only an admin can edit a flight after it has been dispatched.', 403);
    }
    const reason = afterDispatchReason ? String(afterDispatchReason).trim() : '';
    if (!reason) throw new Error('A reason is required to edit a flight after dispatch.');
  }

  const updated = await flightRepository.updateFlight(flightId, patch);
  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_UPDATED', {
    flightId,
    reference: updated.reference,
    changed: Object.keys(patch),
    afterDispatch: !isDraft,
    reason: isDraft ? null : String(afterDispatchReason).trim(),
  });
  return updated;
};

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Locks a flight's box list in and sends it on its way. Refused unless the
 * flight is a DRAFT carrying at least one box and a MAWB, with no manifest
 * upload still sitting in preview. Every MANIFESTED box becomes DISPATCHED and
 * gets a timeline event; the flight is stamped DISPATCHED.
 */
const dispatchFlight = async (id, actorUserId) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  const result = await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (flight.status !== 'DRAFT') {
      throw withStatus('Only a draft flight can be dispatched.', 409);
    }
    if (!flight.mawbNumber) {
      throw new Error('Enter the master air waybill before dispatching.');
    }
    const pending = await flightRepository.countPendingUploads(flightId, tx);
    if (pending > 0) {
      throw new Error('Finish or discard the pending manifest upload before dispatching.');
    }
    const boxCount = await boxRepository.countByFlight(flightId, tx);
    if (boxCount === 0) throw new Error('Add at least one box before dispatching.');

    const toDispatch = await boxRepository.findIdsByFlightAndStatus(flightId, ['MANIFESTED'], tx);
    await boxRepository.transitionFlightBoxes(flightId, ['MANIFESTED'], { status: 'DISPATCHED' }, tx);

    const now = new Date();
    await eventRepository.createEvents(
      toDispatch.map((box) => ({
        boxId: box.id,
        flightId,
        fromStatus: 'MANIFESTED',
        toStatus: 'DISPATCHED',
        eventType: 'DISPATCHED',
        source: 'SYSTEM',
        userId: actorUserId,
      })),
      tx,
    );

    const updated = await flightRepository.updateFlight(
      flightId,
      { status: 'DISPATCHED', dispatchedAt: now, dispatchedByUserId: actorUserId },
      tx,
    );
    return { updated, dispatched: toDispatch.length };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_DISPATCHED', {
    flightId,
    reference: result.updated.reference,
    boxes: result.dispatched,
  });
  return result.updated;
};

// ─── Cancel ─────────────────────────────────────────────────────────────────────

/**
 * Cancels a flight that went out but was recalled before anything was received.
 * Allowed only while DISPATCHED or LANDED and with no box yet received — once a
 * box is at the hub, the exception and override routes take over. Every
 * non-terminal box becomes CANCELLED; a reason is required.
 */
const cancelFlight = async (id, reasonRaw, actorUserId) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const reason = String(reasonRaw ?? '').trim();
  if (!reason) throw new Error('A reason is required to cancel a flight.');

  const result = await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (flight.status !== 'DISPATCHED' && flight.status !== 'LANDED') {
      throw withStatus('Only a dispatched or landed flight with nothing received yet can be cancelled.', 409);
    }
    const received = await prisma.airFreightBox.count({
      where: { flightId, receivedAt: { not: null } },
    });
    if (received > 0) {
      throw withStatus('Boxes have already been received at the hub, so this flight cannot be cancelled.', 409);
    }

    const nonTerminal = Object.keys(require('./air_freight_status').BOX_TRANSITIONS).filter(
      (s) => !TERMINAL_BOX_STATUSES.includes(s),
    );
    const toCancel = await boxRepository.findIdsByFlightAndStatus(flightId, nonTerminal, tx);
    await boxRepository.transitionFlightBoxes(flightId, nonTerminal, { status: 'CANCELLED' }, tx);

    const now = new Date();
    await eventRepository.createEvents(
      toCancel.map((box) => ({
        boxId: box.id,
        flightId,
        fromStatus: box.status,
        toStatus: 'CANCELLED',
        eventType: 'CANCELLED',
        source: 'SYSTEM',
        userId: actorUserId,
        note: reason,
      })),
      tx,
    );

    const updated = await flightRepository.updateFlight(
      flightId,
      { status: 'CANCELLED', cancelledAt: now, cancelledByUserId: actorUserId, cancelReason: reason },
      tx,
    );
    return { updated, cancelled: toCancel.length };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_CANCELLED', {
    flightId,
    reference: result.updated.reference,
    boxes: result.cancelled,
    reason,
  });
  return result.updated;
};

// ─── Landing & customs (Phase 3) ────────────────────────────────────────────────

/** Writes one timeline event per box id with the given transition. */
const writeBoxEvents = (rows, flightId, fromToType, source, actorUserId, note, tx) =>
  eventRepository.createEvents(
    rows.map((box) => ({
      boxId: box.id,
      flightId,
      fromStatus: box.status ?? fromToType.from ?? null,
      toStatus: fromToType.to,
      eventType: fromToType.type,
      source,
      userId: actorUserId,
      note: note ?? null,
    })),
    tx,
  );

/** Marks a dispatched flight landed; every DISPATCHED box becomes LANDED. */
const markLanded = async (id, { landedAt } = {}, actorUserId) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const when = landedAt ? parseDateOrNull(landedAt, 'Landed at') : new Date();

  const result = await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (flight.status !== 'DISPATCHED') {
      throw withStatus('Only a dispatched flight can be marked landed.', 409);
    }
    const boxes = await boxRepository.findIdsByFlightAndStatus(flightId, ['DISPATCHED'], tx);
    await boxRepository.transitionFlightBoxes(flightId, ['DISPATCHED'], { status: 'LANDED' }, tx);
    await writeBoxEvents(boxes, flightId, { to: 'LANDED', type: 'LANDED' }, 'SYSTEM', actorUserId, null, tx);
    await flightRepository.updateFlight(flightId, { landedAt: when, landedByUserId: actorUserId }, tx);
    const status = await recomputeFlightStatus(flightId, tx);
    return { status };
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_LANDED', { flightId });
  return await flightRepository.getFlightById(flightId);
};

/**
 * Flight-wide customs hold: every LANDED/CLEARED/RECEIVED box not on a handover
 * goes to CUSTOMS_HOLD with holdScope FLIGHT, remembering where it came from.
 * Raises one flight-level exception. Needs the flight to have landed.
 */
const customsHoldFlight = async (id, { note } = {}, actorUserId) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);
    if (!flight.landedAt) throw new Error('A flight must have landed before a customs hold.');

    for (const from of ['LANDED', 'CLEARED', 'RECEIVED']) {
      const boxes = await tx.airFreightBox.findMany({
        where: { flightId, status: from, handoverId: null },
        select: { id: true },
      });
      if (boxes.length === 0) continue;
      await tx.airFreightBox.updateMany({
        where: { flightId, status: from, handoverId: null },
        data: { status: 'CUSTOMS_HOLD', statusBeforeHold: from, holdScope: 'FLIGHT' },
      });
      await writeBoxEvents(boxes, flightId, { from, to: 'CUSTOMS_HOLD', type: 'CUSTOMS_HOLD' }, 'SYSTEM', actorUserId, note, tx);
    }

    const existing = await exceptionRepository.findOpen({ flightId, type: 'CUSTOMS_HOLD', boxId: null }, tx);
    if (!existing) {
      await exceptionRepository.createException(
        { flightId, type: 'CUSTOMS_HOLD', status: 'OPEN', ownerRole: 'HUB', raisedByUserId: actorUserId, internalNote: note ?? null },
        tx,
      );
    }
    await flightRepository.updateFlight(flightId, { customsHoldAt: new Date() }, tx);
    await recomputeFlightStatus(flightId, tx);
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_CUSTOMS_HOLD', { flightId });
  return await flightRepository.getFlightById(flightId);
};

/**
 * Flight cleared: flight-held boxes return to where they were (LANDED becomes
 * CLEARED), boxes never held go LANDED→CLEARED, and the flight-level exception
 * is resolved RELEASED. Box-level holds are left alone.
 */
const customsClearedFlight = async (id, actorUserId) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);

  await prisma.$transaction(async (tx) => {
    await lockFlight(flightId, tx);
    const flight = await flightRepository.getFlightCore(flightId, tx);
    if (!flight) throw withStatus('Flight not found.', 404);

    // Flight-held boxes: RECEIVED restores RECEIVED; LANDED/CLEARED become CLEARED.
    const heldReceived = await tx.airFreightBox.findMany({
      where: { flightId, holdScope: 'FLIGHT', statusBeforeHold: 'RECEIVED' }, select: { id: true },
    });
    if (heldReceived.length) {
      await tx.airFreightBox.updateMany({
        where: { flightId, holdScope: 'FLIGHT', statusBeforeHold: 'RECEIVED' },
        data: { status: 'RECEIVED', holdScope: null, statusBeforeHold: null },
      });
      await writeBoxEvents(heldReceived, flightId, { from: 'CUSTOMS_HOLD', to: 'RECEIVED', type: 'CLEARED' }, 'SYSTEM', actorUserId, null, tx);
    }
    const heldOther = await tx.airFreightBox.findMany({
      where: { flightId, holdScope: 'FLIGHT', statusBeforeHold: { in: ['LANDED', 'CLEARED'] } }, select: { id: true },
    });
    if (heldOther.length) {
      await tx.airFreightBox.updateMany({
        where: { flightId, holdScope: 'FLIGHT', statusBeforeHold: { in: ['LANDED', 'CLEARED'] } },
        data: { status: 'CLEARED', holdScope: null, statusBeforeHold: null },
      });
      await writeBoxEvents(heldOther, flightId, { from: 'CUSTOMS_HOLD', to: 'CLEARED', type: 'CLEARED' }, 'SYSTEM', actorUserId, null, tx);
    }
    // Boxes never held: LANDED → CLEARED.
    const landed = await boxRepository.findIdsByFlightAndStatus(flightId, ['LANDED'], tx);
    if (landed.length) {
      await boxRepository.transitionFlightBoxes(flightId, ['LANDED'], { status: 'CLEARED' }, tx);
      await writeBoxEvents(landed, flightId, { from: 'LANDED', to: 'CLEARED', type: 'CLEARED' }, 'SYSTEM', actorUserId, null, tx);
    }

    const open = await exceptionRepository.findOpen({ flightId, type: 'CUSTOMS_HOLD', boxId: null }, tx);
    if (open) {
      await exceptionRepository.updateException(open.id, {
        status: 'RESOLVED', resolution: 'RELEASED', resolvedByUserId: actorUserId, resolvedAt: new Date(),
      }, tx);
    }
    await flightRepository.updateFlight(flightId, { clearedAt: new Date() }, tx);
    await recomputeFlightStatus(flightId, tx);
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_CLEARED', { flightId });
  return await flightRepository.getFlightById(flightId);
};

// ─── Reads ──────────────────────────────────────────────────────────────────────

const shapeCounts = (grouped) => {
  const byStatus = {};
  for (const [status, count] of Object.entries(grouped)) byStatus[status] = count;
  return byStatus;
};

const getFlight = async (id, scopeClientId) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const flight = await flightRepository.getFlightById(flightId);
  if (!flight) throw withStatus('Flight not found.', 404);
  // Cross-tenant reads answer 404, so an id cannot be probed.
  if (scopeClientId && flight.clientId !== scopeClientId) throw withStatus('Flight not found.', 404);

  const [byStatus, byCourier] = await Promise.all([
    boxRepository.countsByStatus(flightId),
    boxRepository.countsByCourier(flightId),
  ]);

  // Fold the per-courier/status rows into one row per courier.
  const courierTotals = new Map();
  for (const row of byCourier) {
    const entry = courierTotals.get(row.courierId) || { courierId: row.courierId, total: 0, byStatus: {} };
    entry.total += row._count._all;
    entry.byStatus[row.status] = row._count._all;
    courierTotals.set(row.courierId, entry);
  }

  return {
    ...flight,
    boxCounts: shapeCounts(byStatus),
    courierCounts: [...courierTotals.values()],
  };
};

const AIR_FREIGHT_FLIGHT_LIST_SPEC = {
  filters: [
    (q) => searchFilter(q.search, ['reference', 'mawbNumber', 'flightNumber', 'client.companyName']),
    (q) => {
      const status = parseEnum(q.status, FLIGHT_STATUSES, { label: 'status' });
      return status ? { status } : undefined;
    },
    (q) => {
      const clientId = parseUuid(q.clientId, 'clientId');
      return clientId ? { clientId } : undefined;
    },
    (q) => {
      const range = dateRangeFilter(q.startDate, q.endDate, { granularity: 'timestamp' });
      return range ? { createdAt: range } : undefined;
    },
  ],
  sort: {
    allowed: {
      createdAt: (order) => ({ createdAt: order }),
      eta: (order) => ({ eta: order }),
      reference: (order) => ({ reference: order }),
      status: (order) => ({ status: order }),
    },
    defaultSort: { field: 'createdAt', order: 'desc' },
    tiebreaker: [{ id: 'desc' }],
  },
};

const listFlights = async (query, scopeClientId) => {
  const { where, orderBy, pagination } = buildListQuery(query, AIR_FREIGHT_FLIGHT_LIST_SPEC);
  const scoped = withScope(where, scopeClientId ? { clientId: scopeClientId } : undefined);
  return await flightRepository.listFlights(scoped, { orderBy, pagination });
};

const summariseFlights = async (query, scopeClientId) => {
  const { where } = buildListQuery(query, AIR_FREIGHT_FLIGHT_LIST_SPEC);
  const scoped = withScope(where, scopeClientId ? { clientId: scopeClientId } : undefined);
  return await flightRepository.summariseByStatus(scoped);
};

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * What deleting a flight would refuse on. Only a DRAFT may go: once dispatched,
 * its boxes are real movements. Boxes, events and uploads cascade; the stored
 * manifest files are released by the sweep afterwards.
 */
const getFlightDependents = async (id, scopeClientId, tx) => {
  const flightId = parseUuid(id, 'Flight');
  if (!flightId) throw withStatus('Flight not found.', 404);
  const flight = await flightRepository.getFlightById(flightId, tx);
  if (!flight) throw withStatus('Flight not found.', 404);
  if (scopeClientId && flight.clientId !== scopeClientId) throw withStatus('Flight not found.', 404);

  return {
    flight,
    report: buildReport({
      blocking: [
        {
          key: 'dispatched',
          label: 'Flight already dispatched',
          count: flight.status === 'DRAFT' ? 0 : 1,
          note: 'Its boxes are in transit. A dispatched flight is cancelled, not deleted.',
        },
      ],
      removedWith: [
        { key: 'boxes', label: 'Boxes on this flight', count: flight._count?.boxes ?? 0 },
        { key: 'uploads', label: 'Manifest uploads', count: flight._count?.uploads ?? 0 },
      ],
    }),
  };
};

const deleteFlight = async (id, scopeClientId, actorUserId) => {
  const result = await prisma.$transaction(async (tx) => {
    const flightId = parseUuid(id, 'Flight');
    await lockForDelete(tx, 'air_freight_flights', flightId);
    const { flight, report } = await getFlightDependents(id, scopeClientId, tx);
    assertDeletable(`Flight ${flight.reference}`, report);
    await flightRepository.deleteFlight(flight.id, tx);
    return flight;
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_FLIGHT_DELETED', {
    flightId: result.id,
    reference: result.reference,
    clientId: result.clientId,
  });
  return { id: result.id };
};

module.exports = {
  createFlight,
  updateFlight,
  dispatchFlight,
  cancelFlight,
  markLanded,
  customsHoldFlight,
  customsClearedFlight,
  writeBoxEvents,
  getFlight,
  listFlights,
  summariseFlights,
  getFlightDependents,
  deleteFlight,
  recomputeFlightStatus,
  AIR_FREIGHT_FLIGHT_LIST_SPEC,
  FLIGHT_STATUSES,
  // Exported for tests.
  nextFlightReference,
  lockFlight,
};
