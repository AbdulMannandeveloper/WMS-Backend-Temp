'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const includeRelations = {
  depots: { orderBy: { name: 'asc' } },
};

const createCourier = async (data, tx) =>
  await db(tx).courier.create({ data, include: includeRelations });

const getCourierById = async (id, tx) =>
  await db(tx).courier.findUnique({ where: { id }, include: includeRelations });

const getCourierByCode = async (code, tx) =>
  await db(tx).courier.findUnique({ where: { code } });

const listCouriers = async ({ activeOnly = false } = {}, tx) =>
  await db(tx).courier.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    include: includeRelations,
    orderBy: { name: 'asc' },
  });

const updateCourier = async (id, data, tx) =>
  await db(tx).courier.update({ where: { id }, data, include: includeRelations });

const deleteCourier = async (id, tx) => await db(tx).courier.delete({ where: { id } });

// ─── Depots ─────────────────────────────────────────────────────────────────

const createDepot = async (data, tx) => await db(tx).courierDepot.create({ data });

const getDepotById = async (id, tx) =>
  await db(tx).courierDepot.findUnique({ where: { id } });

const updateDepot = async (id, data, tx) =>
  await db(tx).courierDepot.update({ where: { id }, data });

const deleteDepot = async (id, tx) => await db(tx).courierDepot.delete({ where: { id } });

// ─── Dependent counts, for delete guards ──────────────────────────────────────

const countCourierBoxes = async (courierId, tx) =>
  await db(tx).airFreightBox.count({ where: { courierId } });

const countCourierHandovers = async (courierId, tx) =>
  await db(tx).airFreightHandover.count({ where: { courierId } });

const countDepotHandovers = async (depotId, tx) =>
  await db(tx).airFreightHandover.count({ where: { depotId } });

module.exports = {
  createCourier,
  getCourierById,
  getCourierByCode,
  listCouriers,
  updateCourier,
  deleteCourier,
  createDepot,
  getDepotById,
  updateDepot,
  deleteDepot,
  countCourierBoxes,
  countCourierHandovers,
  countDepotHandovers,
};
