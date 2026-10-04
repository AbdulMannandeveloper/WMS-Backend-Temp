'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const includeRelations = {
  courier: { select: { id: true, code: true, name: true } },
  depot: { select: { id: true, name: true, address: true } },
  boxes: {
    select: {
      id: true, trackingNumber: true, status: true, flightId: true, clientReference: true,
      declaredWeightKg: true, measuredWeightKg: true,
      flight: { select: { id: true, reference: true } },
    },
    orderBy: { trackingNumber: 'asc' },
  },
};

const createHandover = async (data, tx) =>
  await db(tx).airFreightHandover.create({ data, include: includeRelations });

const getHandoverById = async (id, tx) =>
  await db(tx).airFreightHandover.findUnique({ where: { id }, include: includeRelations });

const updateHandover = async (id, data, tx) =>
  await db(tx).airFreightHandover.update({ where: { id }, data, include: includeRelations });

const getLatestReferencesInSeries = async (prefix, take, tx) =>
  await db(tx).airFreightHandover.findMany({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
    take,
  });

const listHandovers = async (where, { orderBy, pagination }, tx) => {
  const [items, total] = await Promise.all([
    db(tx).airFreightHandover.findMany({
      where, include: includeRelations,
      orderBy: orderBy || [{ openedAt: 'desc' }, { id: 'desc' }],
      skip: pagination?.skip, take: pagination?.take,
    }),
    db(tx).airFreightHandover.count({ where }),
  ]);
  return { items, total };
};

module.exports = {
  createHandover, getHandoverById, updateHandover, getLatestReferencesInSeries, listHandovers, includeRelations,
};
