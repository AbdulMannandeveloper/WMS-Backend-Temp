'use strict';

/**
 * Reading boxes: the searchable list, a single box with its timeline, and the
 * bulk tracking-number lookup a client pastes a column into.
 *
 * Every read is tenant-scoped through the box's flight: a client sees only
 * boxes on their own flights, and a tracking number that belongs to another
 * client comes back as "not found" rather than revealing whose it is. Box
 * mutations (receive, measure, hold, override) arrive in later phases.
 */

const { prisma } = require('../lib/prisma');
const boxRepository = require('../repositories/air_freight_box.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const flightRepository = require('../repositories/air_freight_flight.repository');
const courierRepository = require('../repositories/courier.repository');
const auditLogLogic = require('./audit_log.logic');
const { recomputeFlightStatus, TERMINAL_BOX_STATUSES } = require('./air_freight_status');
const { normaliseTracking } = require('../utils/airFreightTracking');
const {
  buildListQuery,
  parseEnum,
  parseUuid,
  searchFilter,
  withScope,
} = require('../utils/queryFilters');

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

const audit = (actor, action, details) => {
  if (!actor) return Promise.resolve(null);
  return auditLogLogic
    .createAuditLog(actor, action, details)
    .catch((err) => console.error(`Audit (${action}):`, err.message));
};

const BOX_STATUSES = [
  'MANIFESTED', 'DISPATCHED', 'LANDED', 'CUSTOMS_HOLD', 'CLEARED', 'RECEIVED', 'ON_HOLD',
  'ON_HANDOVER', 'HANDED_TO_COURIER', 'SHORT', 'REFUSED_AT_DEPOT', 'RETURNED_TO_CLIENT',
  'WRITTEN_OFF', 'CANCELLED',
];

/** The most a client can look up in one paste; guards a runaway request. */
const MAX_BULK = 500;

const withStatus = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const scopeClause = (scopeClientId) =>
  scopeClientId ? { flight: { clientId: scopeClientId } } : undefined;

const AIR_FREIGHT_BOX_LIST_SPEC = {
  filters: [
    (q) => searchFilter(q.search, ['trackingNumber', 'reference', 'clientReference', 'consigneeName']),
    (q) => {
      const status = parseEnum(q.status, BOX_STATUSES, { label: 'status' });
      return status ? { status } : undefined;
    },
    (q) => {
      const flightId = parseUuid(q.flightId, 'flightId');
      return flightId ? { flightId } : undefined;
    },
    (q) => {
      const courierId = parseUuid(q.courierId, 'courierId');
      return courierId ? { courierId } : undefined;
    },
  ],
  sort: {
    allowed: {
      createdAt: (order) => ({ createdAt: order }),
      trackingNumber: (order) => ({ trackingNumber: order }),
      status: (order) => ({ status: order }),
    },
    defaultSort: { field: 'createdAt', order: 'desc' },
    tiebreaker: [{ id: 'desc' }],
  },
};

const listBoxes = async (query, scopeClientId) => {
  const { where, orderBy, pagination } = buildListQuery(query, AIR_FREIGHT_BOX_LIST_SPEC);
  const scoped = withScope(where, scopeClause(scopeClientId));
  return await boxRepository.listBoxes(scoped, { orderBy, pagination });
};

const getBox = async (id, scopeClientId) => {
  const boxId = parseUuid(id, 'Box');
  if (!boxId) throw withStatus('Box not found.', 404);
  const box = await boxRepository.getBoxById(boxId);
  if (!box) throw withStatus('Box not found.', 404);
  if (scopeClientId && box.flight.clientId !== scopeClientId) throw withStatus('Box not found.', 404);

  const events = await eventRepository.listByBox(boxId);
  return { ...box, events };
};

/**
 * Looks up a list of tracking numbers at once. Returns the boxes found (scoped
 * to the caller) and the numbers that matched nothing. A number on another
 * client's flight counts as not found, so the lookup cannot be used to probe.
 */
const bulkSearch = async (trackingNumbers, scopeClientId) => {
  if (!Array.isArray(trackingNumbers)) throw new Error('Provide a list of tracking numbers.');
  const cleaned = [...new Set(trackingNumbers.map(normaliseTracking).filter(Boolean))];
  if (cleaned.length === 0) throw new Error('No valid tracking numbers to search.');
  if (cleaned.length > MAX_BULK) {
    throw new Error(`Search at most ${MAX_BULK} tracking numbers at once.`);
  }

  const found = [];
  const foundNumbers = new Set();
  for (const tracking of cleaned) {
    const box = await boxRepository.findActiveByTracking(tracking);
    if (!box) continue;
    if (scopeClientId && box.flight.clientId !== scopeClientId) continue;
    found.push(box);
    foundNumbers.add(tracking);
  }
  const notFound = cleaned.filter((t) => !foundNumbers.has(t));
  return { found, notFound };
};

/** Every box on a flight, flat, for the manifest CSV export. Scoped. */
const boxesForExport = async (flightId, scopeClientId) => {
  const result = await boxRepository.listBoxes(
    withScope({ flightId }, scopeClause(scopeClientId)),
    { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], pagination: { skip: 0, take: 100_000 } },
  );
  return result.items;
};

// ─── Mutations: edit, soft-remove, admin override ───────────────────────────────
//
// All three are refused while the flight's billingStatus is POSTED — unpost the
// charges first (logic/air_freight_billing.logic.js), change the box, re-post.
// That unpost→edit→re-post path is the only way a billed box changes, so the
// recomputed statement (calculateFlightCharges reads each box's current state)
// picks the change up with no direct edit of any invoice line.

const EDITABLE_NUMBERS = ['declaredWeightKg', 'lengthCm', 'widthCm', 'heightCm', 'declaredValue'];
const OVERRIDE_REFUSED_TARGETS = ['ON_HANDOVER', 'CUSTOMS_HOLD'];

const lockFlight = async (id, tx) => {
  await tx.$queryRaw`SELECT id FROM air_freight_flights WHERE id = ${id}::uuid FOR UPDATE`;
};

const loadBoxAndFlight = async (idRaw, tx) => {
  const id = parseUuid(idRaw, 'Box');
  if (!id) throw withStatus('Box not found.', 404);
  const box = await boxRepository.getBoxById(id, tx);
  if (!box) throw withStatus('Box not found.', 404);
  const flight = await flightRepository.getFlightCore(box.flightId, tx);
  if (!flight) throw withStatus('Box not found.', 404);
  return { box, flight };
};

/** Shared guard: never while POSTED; after dispatch admin-only + a reason. */
const assertMutable = (flight, { actorRole, reason, action }) => {
  if (flight.billingStatus === 'POSTED') {
    throw withStatus(`Unpost this flight's charges before you ${action} a box.`, 409);
  }
  if (flight.status !== 'DRAFT') {
    if (actorRole && actorRole !== 'admin') {
      throw withStatus(`Only an admin can ${action} a box after the flight is dispatched.`, 403);
    }
    if (!reason || !String(reason).trim()) {
      throw new Error(`A reason is required to ${action} a box after dispatch.`);
    }
  }
};

const positive = (v, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a number greater than zero.`);
  return n;
};

const mapTrackingClash = (error) => {
  if (error?.code === 'P2002') return withStatus('That tracking number is already on another active box.', 409);
  return error;
};

/**
 * Edits a box's manifest fields. DRAFT: free. After dispatch: admin + reason.
 * A changed tracking number is checked against the active index and the old one
 * kept in previousTrackingNumbers. Refused while the flight is POSTED.
 */
const editBox = async (idRaw, data, actorUserId, actorRole) => {
  const result = await prisma.$transaction(async (tx) => {
    const { box, flight } = await loadBoxAndFlight(idRaw, tx);
    assertMutable(flight, { actorRole, reason: data.reason, action: 'edit' });

    const patch = {};
    const changed = [];
    const setText = (f, { required = false, max = 255, upper = false } = {}) => {
      if (!(f in data)) return;
      let v = data[f] === null || data[f] === undefined ? '' : String(data[f]).trim();
      if (upper) v = v.toUpperCase();
      if (!v) {
        if (required) throw new Error(`${f} cannot be empty.`);
        patch[f] = null;
      } else {
        patch[f] = v.slice(0, max);
      }
      changed.push(f);
    };
    setText('clientReference', { max: 80 });
    setText('reference', { max: 80 });
    setText('contentsDescription', { required: true, max: 255 });
    setText('consigneeName', { required: true, max: 160 });
    setText('consigneePostcode', { required: true, max: 20 });
    setText('currency', { required: true, max: 3, upper: true });
    if ('currency' in patch && patch.currency && !/^[A-Z]{3}$/.test(patch.currency)) {
      throw new Error('Currency must be a 3-letter code, e.g. GBP.');
    }
    if ('hsCode' in data) {
      const hs = data.hsCode ? String(data.hsCode).replace(/\s+/g, '') : null;
      if (hs && !/^\d{6,10}$/.test(hs)) throw new Error('HS code must be 6 to 10 digits.');
      patch.hsCode = hs;
      changed.push('hsCode');
    }
    for (const f of EDITABLE_NUMBERS) {
      if (f in data) { patch[f] = positive(data[f], f); changed.push(f); }
    }
    if ('courierId' in data && data.courierId && data.courierId !== box.courierId) {
      const courierId = parseUuid(data.courierId, 'Courier');
      const courier = courierId ? await courierRepository.getCourierById(courierId, tx) : null;
      if (!courier) throw withStatus('That courier does not exist.', 404);
      if (!courier.isActive) throw new Error(`Courier ${courier.code} is deactivated.`);
      patch.courierId = courierId;
      changed.push('courier');
    }
    if ('trackingNumber' in data) {
      const tn = normaliseTracking(data.trackingNumber);
      if (!tn) throw new Error('That is not a valid tracking number.');
      if (tn !== box.trackingNumber) {
        const clash = await boxRepository.findActiveByTracking(tn, tx);
        if (clash && clash.id !== box.id) {
          throw withStatus('That tracking number is already on another active box.', 409);
        }
        patch.trackingNumber = tn;
        patch.previousTrackingNumbers = [...(box.previousTrackingNumbers || []), box.trackingNumber];
        changed.push('tracking');
      }
    }
    if (changed.length === 0) throw new Error('Nothing to update.');

    try {
      await boxRepository.updateBox(box.id, patch, tx);
    } catch (error) {
      throw mapTrackingClash(error);
    }
    await eventRepository.createEvent({
      boxId: box.id, flightId: box.flightId, fromStatus: box.status, toStatus: box.status,
      eventType: 'EDITED', source: 'MANUAL', userId: actorUserId,
      note: `${changed.join(', ')}${data.reason ? ` — ${String(data.reason).trim()}` : ''}`.slice(0, 1000),
    }, tx);
    await recomputeFlightStatus(box.flightId, tx);
    return box;
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_BOX_EDITED', { boxId: result.id, flightId: result.flightId });
  return await boxRepository.getBoxById(result.id);
};

/** Soft-removes a box: it becomes CANCELLED (reversible via override, dropped from billing). */
const removeBox = async (idRaw, reasonRaw, actorUserId, actorRole) => {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason) throw new Error('A reason is required to remove a box.');
  const result = await prisma.$transaction(async (tx) => {
    const { box, flight } = await loadBoxAndFlight(idRaw, tx);
    assertMutable(flight, { actorRole, reason, action: 'remove' });
    if (TERMINAL_BOX_STATUSES.includes(box.status)) {
      throw withStatus(`This box is already ${box.status.toLowerCase().replace(/_/g, ' ')}.`, 409);
    }
    if (box.status === 'ON_HANDOVER') {
      throw withStatus('Take the box off its open handover first.', 409);
    }
    await lockFlight(box.flightId, tx);
    await boxRepository.updateBox(box.id, { status: 'CANCELLED', handoverId: null }, tx);
    await eventRepository.createEvent({
      boxId: box.id, flightId: box.flightId, fromStatus: box.status, toStatus: 'CANCELLED',
      eventType: 'REMOVED', source: 'MANUAL', userId: actorUserId, note: reason,
    }, tx);
    await recomputeFlightStatus(box.flightId, tx);
    return box;
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_BOX_REMOVED', { boxId: result.id, flightId: result.flightId, reason });
  return await boxRepository.getBoxById(result.id);
};

/** Admin override of a box status (§1G): sets side-fields, refuses the real-action targets. */
const overrideStatus = async (idRaw, { toStatus, reason } = {}, actorUserId) => {
  const r = String(reason ?? '').trim();
  if (!r) throw new Error('A reason is required to override a box status.');
  if (!BOX_STATUSES.includes(toStatus)) throw new Error('Unknown target status.');
  if (OVERRIDE_REFUSED_TARGETS.includes(toStatus)) {
    throw new Error(`Use the handover / customs action to move a box to ${toStatus}.`);
  }
  const result = await prisma.$transaction(async (tx) => {
    const { box, flight } = await loadBoxAndFlight(idRaw, tx);
    if (flight.billingStatus === 'POSTED') {
      throw withStatus("Unpost this flight's charges before overriding a box.", 409);
    }
    await lockFlight(box.flightId, tx);
    const from = box.status;
    if (from === toStatus) return box;

    const now = new Date();
    const patch = { status: toStatus };
    if (toStatus === 'RECEIVED' && !box.receivedAt) { patch.receivedAt = now; patch.receivedByUserId = actorUserId; }
    if (toStatus === 'HANDED_TO_COURIER') patch.handedOverAt = now;
    if (toStatus === 'RETURNED_TO_CLIENT') patch.returnedAt = now;
    if (toStatus === 'WRITTEN_OFF') patch.writtenOffAt = now;
    if (from === 'ON_HANDOVER' && box.handoverId) {
      const ho = await tx.airFreightHandover.findUnique({ where: { id: box.handoverId }, select: { status: true } });
      if (ho?.status === 'OPEN') patch.handoverId = null;
    }

    try {
      await boxRepository.updateBox(box.id, patch, tx);
    } catch (error) {
      throw mapTrackingClash(error);
    }
    await eventRepository.createEvent({
      boxId: box.id, flightId: box.flightId, fromStatus: from, toStatus,
      eventType: 'OVERRIDE', source: 'MANUAL', userId: actorUserId, note: r,
    }, tx);
    await recomputeFlightStatus(box.flightId, tx);
    return box;
  }, TRANSACTION_OPTIONS);

  await audit(actorUserId, 'AIR_FREIGHT_BOX_OVERRIDE', { boxId: result.id, toStatus, reason: r });
  return await boxRepository.getBoxById(result.id);
};

module.exports = {
  listBoxes,
  getBox,
  bulkSearch,
  boxesForExport,
  editBox,
  removeBox,
  overrideStatus,
  AIR_FREIGHT_BOX_LIST_SPEC,
  BOX_STATUSES,
  MAX_BULK,
};
