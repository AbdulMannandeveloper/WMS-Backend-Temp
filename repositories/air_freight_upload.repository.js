'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const createUpload = async (data, tx) => await db(tx).airFreightUpload.create({ data });

const getUploadById = async (id, tx) =>
  await db(tx).airFreightUpload.findUnique({
    where: { id },
    include: { flight: { select: { id: true, clientId: true, status: true } } },
  });

const updateUpload = async (id, data, tx) =>
  await db(tx).airFreightUpload.update({ where: { id }, data });

const listByFlight = async (flightId, tx) =>
  await db(tx).airFreightUpload.findMany({
    where: { flightId },
    orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
  });

/** The highest committed version on a flight, so the next commit is version + 1. */
const maxVersion = async (flightId, tx) => {
  const row = await db(tx).airFreightUpload.aggregate({
    where: { flightId, version: { not: null } },
    _max: { version: true },
  });
  return row._max.version ?? 0;
};

module.exports = { createUpload, getUploadById, updateUpload, listByFlight, maxVersion };
