'use strict';

const { prisma } = require('../lib/prisma');
const { assertAllowedField } = require('../utils/pick');

/**
 * Columns a caller may look a freight shipment up by.
 *
 * `barcode` and `reference` are both here because the bench reaches a shipment
 * by either: the gun reads the barcode, and a fingernail over the label means
 * someone keys the reference instead.
 */
const FREIGHT_QUERY_FIELDS = ['id', 'reference', 'barcode', 'status'];

/**
 * A person, named — and nothing else.
 *
 * The same shape the shipment repository uses, and for the same reason: a bare
 * `user: true` returns every scalar on User, one of which is `passwordHash`.
 */
const userSummary = {
  select: { id: true, firstName: true, lastName: true, email: true },
};

/**
 * Everything the detail page shows, in one read.
 *
 * The actor ids (created/dispatched/received by) are *not* relations on these
 * models — see the schema comment — so they cannot be included here. They are
 * resolved by getUserSummaries below, in one batch, by the logic layer.
 */
const includeRelations = {
  documents: { orderBy: { uploadedAt: 'desc' } },
  receiving: true,
};

const db = (tx) => tx || prisma;

const createFreightShipment = async (data, tx) =>
  await db(tx).freightShipment.create({ data, include: includeRelations });

const getFreightShipmentByField = async (field, value, tx) => {
  assertAllowedField(field, FREIGHT_QUERY_FIELDS);
  return await db(tx).freightShipment.findFirst({
    where: { [field]: value },
    include: includeRelations,
  });
};

/**
 * One page of the list, plus the total the pager needs.
 *
 * The same shape as getAllInventoryLedgers: with pagination it returns
 * `{ items, total }`, and without it the whole filtered set, because a caller
 * that asked for no page wants no envelope either.
 */
const getAllFreightShipments = async (where = {}, { orderBy, pagination, tx } = {}) => {
  const client = db(tx);
  const sort = orderBy || [{ createdAt: 'desc' }, { id: 'asc' }];

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      client.freightShipment.findMany({
        where,
        include: includeRelations,
        orderBy: sort,
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      client.freightShipment.count({ where }),
    ]);
    return { items, total };
  }

  return await client.freightShipment.findMany({
    where,
    include: includeRelations,
    orderBy: sort,
  });
};

/** Counts per status across the whole filtered set, not the page. */
const summariseFreightShipments = async (where = {}, tx) => {
  const client = db(tx);
  const [total, byStatus, weight] = await Promise.all([
    client.freightShipment.count({ where }),
    client.freightShipment.groupBy({ by: ['status'], where, _count: { _all: true } }),
    // Aggregated in the database rather than summed in JavaScript: `weight` is a
    // Prisma Decimal, and adding those with `+` concatenates them.
    client.freightShipment.aggregate({ where, _sum: { weight: true } }),
  ]);

  return { total, byStatus, totalWeight: weight._sum.weight };
};

/**
 * The highest references already issued in a series, newest first.
 *
 * Lifted from shipment.repository.js unchanged in shape, including the reason it
 * takes several rows rather than one: a reference written by hand or by an older
 * scheme sorts above the generated ones (a letter beats a digit), and the caller
 * takes the first that parses so one odd row cannot send the sequence back to 1.
 * `reference` is unique, so this rides its index.
 */
const getLatestReferencesInSeries = async (prefix, take, tx) =>
  await db(tx).freightShipment.findMany({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
    take,
  });

const updateFreightShipment = async (id, data, tx) =>
  await db(tx).freightShipment.update({
    where: { id },
    data,
    include: includeRelations,
  });

const deleteFreightShipment = async (id, tx) =>
  await db(tx).freightShipment.delete({ where: { id } });

// ─── Documents ────────────────────────────────────────────────────────────────

const createDocument = async (data, tx) =>
  await db(tx).freightShipmentDocument.create({ data });

const getDocumentById = async (id, tx) =>
  await db(tx).freightShipmentDocument.findUnique({ where: { id } });

const getDocumentByStorageKey = async (storageKey, tx) =>
  await db(tx).freightShipmentDocument.findFirst({ where: { storageKey } });

const deleteDocument = async (id, tx) =>
  await db(tx).freightShipmentDocument.delete({ where: { id } });

// ─── Receiving ────────────────────────────────────────────────────────────────

const createReceivingRecord = async (data, tx) =>
  await db(tx).freightReceivingRecord.create({ data });

// ─── Cross-model reads this module owns ───────────────────────────────────────

/**
 * Names for a set of user ids, in one query.
 *
 * Reaching into User from the freight repository rather than adding four
 * relations to FreightShipment. The ids are audit breadcrumbs — see the schema
 * comment — and a relation per breadcrumb would have put four joins on every row
 * of a list page to render four names that are usually the same person.
 *
 * Returns a Map so the caller does one pass over its rows.
 */
const getUserSummaries = async (ids, tx) => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const users = await db(tx).user.findMany({
    where: { id: { in: wanted } },
    ...userSummary,
  });

  return new Map(users.map((user) => [user.id, user]));
};

/**
 * This module's slice of the shared audit table.
 *
 * Matched on the action prefix and on the shipment id appearing in `details`,
 * which is a JSON string rather than a column — that is how audit_logs has
 * always stored its payload, and adding a typed backlink would mean migrating
 * every other module's rows to fill it.
 */
const getAuditTrail = async (shipmentId, tx) =>
  await db(tx).auditLog.findMany({
    where: {
      action: { startsWith: 'FREIGHT_SHIPMENT_' },
      details: { contains: shipmentId },
    },
    orderBy: { timestamp: 'desc' },
    include: { user: userSummary },
  });

module.exports = {
  createFreightShipment,
  getFreightShipmentByField,
  getAllFreightShipments,
  summariseFreightShipments,
  getLatestReferencesInSeries,
  updateFreightShipment,
  deleteFreightShipment,
  createDocument,
  getDocumentById,
  getDocumentByStorageKey,
  deleteDocument,
  createReceivingRecord,
  getUserSummaries,
  getAuditTrail,
};
