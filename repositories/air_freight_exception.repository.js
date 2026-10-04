'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

// AirFreightException.boxId is a plain FK (no Prisma relation, by schema design),
// so a box's details are fetched separately when a view needs them.
const includeRelations = {
  flight: { select: { id: true, reference: true, clientId: true } },
};

const createException = async (data, tx) =>
  await db(tx).airFreightException.create({ data, include: includeRelations });

const getExceptionById = async (id, tx) =>
  await db(tx).airFreightException.findUnique({ where: { id }, include: includeRelations });

const updateException = async (id, data, tx) =>
  await db(tx).airFreightException.update({ where: { id }, data, include: includeRelations });

/** Open exceptions of a type on a flight, optionally for one box or scanned code. */
const findOpen = async ({ flightId, type, boxId, scannedCode, statuses }, tx) =>
  await db(tx).airFreightException.findFirst({
    where: {
      flightId,
      ...(type ? { type } : {}),
      ...(boxId !== undefined ? { boxId } : {}),
      ...(scannedCode ? { scannedCode } : {}),
      status: { in: statuses || ['OPEN', 'AWAITING_CLIENT'] },
    },
    include: includeRelations,
  });

/** Resolve every open exception on a box (e.g. a found SHORT), returns count. */
const resolveOpenForBox = async (boxId, data, tx) => {
  const { count } = await db(tx).airFreightException.updateMany({
    where: { boxId, status: { in: ['OPEN', 'AWAITING_CLIENT'] } },
    data,
  });
  return count;
};

const listByFlight = async (flightId, tx) =>
  await db(tx).airFreightException.findMany({
    where: { flightId },
    include: includeRelations,
    orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
  });

const countOpenByFlight = async (flightId, tx) =>
  await db(tx).airFreightException.count({
    where: { flightId, status: { in: ['OPEN', 'AWAITING_CLIENT'] } },
  });

module.exports = {
  createException,
  getExceptionById,
  updateException,
  findOpen,
  resolveOpenForBox,
  listByFlight,
  countOpenByFlight,
  includeRelations,
};
