const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const LEDGER_QUERY_FIELDS = [
  "id",
  "productId",
  "userId",
  "movementType",
  "referenceId",
  "fromLocationId",
  "toLocationId",
];

const includeRelations = {
  product: {
    include: {
      client: {
        select: { id: true, companyName: true, contactName: true, email: true },
      },
    },
  },
  user: {
    select: { id: true, firstName: true, lastName: true, username: true, role: true },
  },
  fromLocation: {
    include: { locationClass: true },
  },
  toLocation: {
    include: { locationClass: true },
  },
};

const db = (tx) => tx || prisma;

const createInventoryLedger = async (data, tx) => {
  return await db(tx).inventoryLedger.create({
    data,
    include: includeRelations,
  });
};

/**
 * @param {object} filters
 * @param {{ skip?: number, take?: number } | undefined} pagination
 * When pagination.take is set, returns { items, total }; otherwise a plain array
 * for backward-compatible callers (filters, daily summary, etc.).
 */
const getAllInventoryLedgers = async (filters = {}, pagination, tx) => {
  const client = db(tx);
  const where = filters;
  const orderBy = { timestamp: "desc" };

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      client.inventoryLedger.findMany({
        where,
        include: includeRelations,
        orderBy,
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      client.inventoryLedger.count({ where }),
    ]);
    return { items, total };
  }

  return await client.inventoryLedger.findMany({
    where,
    include: includeRelations,
    orderBy,
  });
};

const getInventoryLedgerByField = async (field, value, tx) => {
  assertAllowedField(field, LEDGER_QUERY_FIELDS);
  return await db(tx).inventoryLedger.findMany({
    where: { [field]: value },
    include: includeRelations,
    orderBy: { timestamp: "desc" },
  });
};

const deleteInventoryLedger = async (id, tx) => {
  return await db(tx).inventoryLedger.delete({
    where: { id },
  });
};

module.exports = {
  createInventoryLedger,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  deleteInventoryLedger,
};
