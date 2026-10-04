'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

/** The box timeline is insert-only; there is no update or delete here by design. */
const createEvent = async (data, tx) => await db(tx).airFreightBoxEvent.create({ data });

/** Many at once, for a flight-level transition that touches every box. */
const createEvents = async (rows, tx) => {
  if (!rows || rows.length === 0) return { count: 0 };
  return await db(tx).airFreightBoxEvent.createMany({ data: rows });
};

const listByBox = async (boxId, tx) =>
  await db(tx).airFreightBoxEvent.findMany({
    where: { boxId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

const listByFlight = async (flightId, { orderBy, pagination }, tx) => {
  const [items, total] = await Promise.all([
    db(tx).airFreightBoxEvent.findMany({
      where: { flightId },
      orderBy: orderBy || [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: pagination?.skip,
      take: pagination?.take,
    }),
    db(tx).airFreightBoxEvent.count({ where: { flightId } }),
  ]);
  return { items, total };
};

module.exports = { createEvent, createEvents, listByBox, listByFlight };
