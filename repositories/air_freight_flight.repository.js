'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const clientSummary = { select: { id: true, companyName: true, email: true } };

const includeRelations = {
  client: clientSummary,
  _count: { select: { boxes: true, exceptions: true, uploads: true } },
};

const createFlight = async (data, tx) =>
  await db(tx).airFreightFlight.create({ data, include: includeRelations });

const getFlightById = async (id, tx) =>
  await db(tx).airFreightFlight.findUnique({ where: { id }, include: includeRelations });

/**
 * The columns recomputeFlightStatus reads: cheap, and no relations. Separate
 * from getFlightById so the recompute that runs after every box change does not
 * drag the client and the counts along with it.
 */
const getFlightCore = async (id, tx) =>
  await db(tx).airFreightFlight.findUnique({
    where: { id },
    select: {
      id: true,
      clientId: true,
      status: true,
      landedAt: true,
      clearedAt: true,
      receiptClosedAt: true,
      completedAt: true,
      billingStatus: true,
      mawbNumber: true,
    },
  });

const updateFlight = async (id, data, tx) =>
  await db(tx).airFreightFlight.update({ where: { id }, data, include: includeRelations });

const deleteFlight = async (id, tx) => await db(tx).airFreightFlight.delete({ where: { id } });

/**
 * The most recent references in a series (e.g. "AF-2026-"), highest first, for
 * the sequence generator. Mirrors the other modules' reference repositories.
 */
const getLatestReferencesInSeries = async (prefix, take, tx) =>
  await db(tx).airFreightFlight.findMany({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
    take,
  });

const listFlights = async (where, { orderBy, pagination }, tx) => {
  const [items, total] = await Promise.all([
    db(tx).airFreightFlight.findMany({
      where,
      include: includeRelations,
      orderBy,
      skip: pagination?.skip,
      take: pagination?.take,
    }),
    db(tx).airFreightFlight.count({ where }),
  ]);
  return { items, total };
};

/** `{ STATUS: count }` over the same `where` as the list, for the summary tiles. */
const summariseByStatus = async (where, tx) => {
  const grouped = await db(tx).airFreightFlight.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });
  const counts = {};
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
};

/** Uploads still in PREVIEW on a flight — a dispatch is refused while any remain. */
const countPendingUploads = async (flightId, tx) =>
  await db(tx).airFreightUpload.count({ where: { flightId, status: 'PREVIEW' } });

module.exports = {
  createFlight,
  getFlightById,
  getFlightCore,
  updateFlight,
  deleteFlight,
  getLatestReferencesInSeries,
  listFlights,
  summariseByStatus,
  countPendingUploads,
};
