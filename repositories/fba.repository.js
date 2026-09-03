'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const includeRelations = {
  category: true,
  client: { select: { id: true, companyName: true } },
};

// ─── Categories ───────────────────────────────────────────────────────────────

const createCategory = async (data, tx) =>
  await db(tx).fbaCategory.create({ data });

const getAllCategories = async (tx) =>
  await db(tx).fbaCategory.findMany({ orderBy: { name: 'asc' } });

const getCategoryById = async (id, tx) =>
  await db(tx).fbaCategory.findUnique({ where: { id } });

const getCategoryByName = async (name, tx) =>
  await db(tx).fbaCategory.findUnique({ where: { name } });

const updateCategory = async (id, data, tx) =>
  await db(tx).fbaCategory.update({ where: { id }, data });

const deleteCategory = async (id, tx) =>
  await db(tx).fbaCategory.delete({ where: { id } });

const countShipmentsInCategory = async (categoryId, tx) =>
  await db(tx).fbaShipment.count({ where: { categoryId } });

// ─── Shipments ────────────────────────────────────────────────────────────────

const createShipment = async (data, tx) =>
  await db(tx).fbaShipment.create({ data, include: includeRelations });

const getAllShipments = async (tx) =>
  await db(tx).fbaShipment.findMany({
    include: includeRelations,
    orderBy: { receivedAt: 'desc' },
  });

const getShipmentsByClientId = async (clientId, tx) =>
  await db(tx).fbaShipment.findMany({
    where: { clientId },
    include: includeRelations,
    orderBy: { receivedAt: 'desc' },
  });

const getShipmentById = async (id, tx) =>
  await db(tx).fbaShipment.findUnique({ where: { id }, include: includeRelations });

const updateShipment = async (id, data, tx) =>
  await db(tx).fbaShipment.update({ where: { id }, data, include: includeRelations });

const deleteShipment = async (id, tx) =>
  await db(tx).fbaShipment.delete({ where: { id } });

module.exports = {
  createCategory,
  getAllCategories,
  getCategoryById,
  getCategoryByName,
  updateCategory,
  deleteCategory,
  countShipmentsInCategory,
  createShipment,
  getAllShipments,
  getShipmentsByClientId,
  getShipmentById,
  updateShipment,
  deleteShipment,
};
