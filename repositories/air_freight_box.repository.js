'use strict';

const { prisma } = require('../lib/prisma');
const { ACTIVE_BOX_STATUSES } = require('../logic/air_freight_status');

const db = (tx) => tx || prisma;

/** How many values go into one `IN (...)` or one createMany — Postgres parameter safe. */
const CHUNK = 1_000;

const courierSummary = { select: { id: true, code: true, name: true, trackingUrlTemplate: true } };

const includeRelations = {
  courier: courierSummary,
  flight: { select: { id: true, reference: true, mawbNumber: true, clientId: true, status: true } },
};

const createMany = async (rows, tx) => await db(tx).airFreightBox.createMany({ data: rows });

/** Boxes created and handed back, in chunks so a 20k manifest stays within limits. */
const createManyAndReturn = async (rows, tx) => {
  const created = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const batch = await db(tx).airFreightBox.createManyAndReturn({
      data: slice,
      select: { id: true, trackingNumber: true, courierId: true, status: true },
    });
    created.push(...batch);
  }
  return created;
};

const getBoxById = async (id, tx) =>
  await db(tx).airFreightBox.findUnique({ where: { id }, include: includeRelations });

/** Every box on a flight, for a REPLACE upload that clears the manifest first. */
const findIdsByFlight = async (flightId, tx) =>
  await db(tx).airFreightBox.findMany({ where: { flightId }, select: { id: true } });

const deleteByFlight = async (flightId, tx) =>
  await db(tx).airFreightBox.deleteMany({ where: { flightId } });

const countByFlight = async (flightId, tx) =>
  await db(tx).airFreightBox.count({ where: { flightId } });

/**
 * The live box carrying a tracking number, or null.
 *
 * An exact match on the normalised value among active statuses only — the same
 * predicate as the partial unique index, so at most one box can match. Both the
 * stored and the searched value are already uppercased by normaliseTracking, so
 * there is no case-insensitive fallback to pay for: an ILIKE here would only
 * ever full-scan the table on a miss.
 */
const findActiveByTracking = async (trackingNumber, tx) =>
  await db(tx).airFreightBox.findFirst({
    where: { trackingNumber, status: { in: ACTIVE_BOX_STATUSES } },
    include: includeRelations,
  });

/** Any box with this tracking (incl. terminal), newest first — for the scan miss path. */
const findAnyByTracking = async (trackingNumber, tx) =>
  await db(tx).airFreightBox.findFirst({
    where: { trackingNumber },
    include: includeRelations,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

/** Count of boxes physically at the hub (have a receivedAt), for counters. */
const countReceived = async (flightId, tx) =>
  await db(tx).airFreightBox.count({ where: { flightId, receivedAt: { not: null } } });

/**
 * Which of a list of tracking numbers are already live, as a Set.
 *
 * Used by manifest validation to block a number held by an active box.
 * `excludeFlightId` drops this flight's own boxes from the check — a REPLACE is
 * about to delete them, so they are not really taken.
 */
const existingTrackingNumbers = async (list, { excludeFlightId } = {}, tx) => {
  const found = new Set();
  const unique = [...new Set(list)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const rows = await db(tx).airFreightBox.findMany({
      where: {
        trackingNumber: { in: slice },
        status: { in: ACTIVE_BOX_STATUSES },
        ...(excludeFlightId ? { flightId: { not: excludeFlightId } } : {}),
      },
      select: { trackingNumber: true },
    });
    for (const row of rows) found.add(row.trackingNumber);
  }
  return found;
};

/**
 * Moves a box's status, only from one of `fromStatuses`. The conditional update
 * is the lock: two scans racing to receive the same box cannot both win. Returns
 * the number of rows moved — 0 means it was no longer in an allowed state.
 */
const transitionIfStatus = async (id, fromStatuses, data, tx) => {
  const { count } = await db(tx).airFreightBox.updateMany({
    where: { id, status: { in: fromStatuses } },
    data,
  });
  return count;
};

/** Bulk flight-level transition (e.g. every MANIFESTED box → DISPATCHED). */
const transitionFlightBoxes = async (flightId, fromStatuses, data, tx) => {
  const { count } = await db(tx).airFreightBox.updateMany({
    where: { flightId, status: { in: fromStatuses } },
    data,
  });
  return count;
};

/** Ids of the boxes a flight-level transition would touch, for writing events. */
const findIdsByFlightAndStatus = async (flightId, fromStatuses, tx) =>
  await db(tx).airFreightBox.findMany({
    where: { flightId, status: { in: fromStatuses } },
    select: { id: true, status: true },
  });

/** `{ STATUS: count }` over non-cancelled boxes — the input to recomputeFlightStatus. */
const countsByStatus = async (flightId, tx) => {
  const grouped = await db(tx).airFreightBox.groupBy({
    by: ['status'],
    where: { flightId },
    _count: { _all: true },
  });
  const counts = {};
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
};

/** Received-but-not-handed-over counts per courier, for the sort / handover view. */
const countsByCourier = async (flightId, tx) =>
  await db(tx).airFreightBox.groupBy({
    by: ['courierId', 'status'],
    where: { flightId },
    _count: { _all: true },
  });

const listBoxes = async (where, { orderBy, pagination }, tx) => {
  const [items, total] = await Promise.all([
    db(tx).airFreightBox.findMany({
      where,
      include: includeRelations,
      orderBy,
      skip: pagination?.skip,
      take: pagination?.take,
    }),
    db(tx).airFreightBox.count({ where }),
  ]);
  return { items, total };
};

const updateBox = async (id, data, tx) =>
  await db(tx).airFreightBox.update({ where: { id }, data, include: includeRelations });

module.exports = {
  createMany,
  createManyAndReturn,
  getBoxById,
  findIdsByFlight,
  deleteByFlight,
  countByFlight,
  findActiveByTracking,
  findAnyByTracking,
  countReceived,
  existingTrackingNumbers,
  transitionIfStatus,
  transitionFlightBoxes,
  findIdsByFlightAndStatus,
  countsByStatus,
  countsByCourier,
  listBoxes,
  updateBox,
  CHUNK,
};
