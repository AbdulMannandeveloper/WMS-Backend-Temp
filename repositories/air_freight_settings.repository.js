'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const getByClientId = async (clientId, tx) =>
  await db(tx).airFreightClientSettings.findUnique({ where: { clientId } });

const upsert = async (clientId, data, tx) =>
  await db(tx).airFreightClientSettings.upsert({
    where: { clientId },
    create: { clientId, ...data },
    update: data,
  });

module.exports = { getByClientId, upsert };
