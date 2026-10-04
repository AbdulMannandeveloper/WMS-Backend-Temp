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

const boxRepository = require('../repositories/air_freight_box.repository');
const eventRepository = require('../repositories/air_freight_event.repository');
const { normaliseTracking } = require('../utils/airFreightTracking');
const {
  buildListQuery,
  parseEnum,
  parseUuid,
  searchFilter,
  withScope,
} = require('../utils/queryFilters');

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

module.exports = {
  listBoxes,
  getBox,
  bulkSearch,
  boxesForExport,
  AIR_FREIGHT_BOX_LIST_SPEC,
  BOX_STATUSES,
  MAX_BULK,
};
