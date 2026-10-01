'use strict';

const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const includeRelations = {
  category: true,
  client: { select: { id: true, companyName: true, clientUniqueNumber: true } },
  items: {
    include: {
      product: { select: { id: true, skuCode: true, productName: true } },
      sourceLocation: { select: { id: true, locationName: true, materializedPath: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  services: {
    include: { service: { select: { id: true, description: true, unit: true } } },
  },
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

/**
 * The most recent references in a series (e.g. "BULK-2026-"), highest first, for
 * the sequence generator. Mirrors shipment.repository.getLatestReferencesInSeries.
 */
const getLatestReferencesInSeries = async (prefix, take, tx) =>
  await db(tx).fbaShipment.findMany({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
    take,
  });

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

// ─── Shipment items (the scanned products) ──────────────────────────────────────

const getItemsByShipment = async (fbaShipmentId, tx) =>
  await db(tx).fbaShipmentItem.findMany({ where: { fbaShipmentId } });

const createItem = async (data, tx) =>
  await db(tx).fbaShipmentItem.create({ data });

const updateItem = async (id, data, tx) =>
  await db(tx).fbaShipmentItem.update({ where: { id }, data });

const deleteItemsByShipment = async (fbaShipmentId, tx) =>
  await db(tx).fbaShipmentItem.deleteMany({ where: { fbaShipmentId } });

const deleteItemsByIds = async (ids, tx) =>
  await db(tx).fbaShipmentItem.deleteMany({ where: { id: { in: ids } } });

// ─── Attached services ─────────────────────────────────────────────────────────

const createService = async (data, tx) =>
  await db(tx).fbaShipmentService.create({ data });

const updateService = async (id, data, tx) =>
  await db(tx).fbaShipmentService.update({ where: { id }, data });

const deleteServicesByShipment = async (fbaShipmentId, tx) =>
  await db(tx).fbaShipmentService.deleteMany({ where: { fbaShipmentId } });

module.exports = {
  createCategory,
  getAllCategories,
  getCategoryById,
  getCategoryByName,
  updateCategory,
  deleteCategory,
  countShipmentsInCategory,
  createShipment,
  getLatestReferencesInSeries,
  getAllShipments,
  getShipmentsByClientId,
  getShipmentById,
  updateShipment,
  deleteShipment,
  getItemsByShipment,
  createItem,
  updateItem,
  deleteItemsByShipment,
  deleteItemsByIds,
  createService,
  updateService,
  deleteServicesByShipment,
};
