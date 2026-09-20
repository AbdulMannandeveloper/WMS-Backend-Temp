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
 * @param {object} where - a Prisma where; {} matches everything.
 * @param {object} [options]
 * @param {object[]} [options.orderBy] - ends in a unique key, or pages repeat rows.
 * @param {object} [options.pagination] - absent, the whole set comes back as a
 *   bare array, which the daily checkout summary and the product detail read.
 * @param {object} [options.tx]
 */
const getAllInventoryLedgers = async (where = {}, { orderBy, pagination, tx } = {}) => {
  const client = db(tx);
  const sort = orderBy || [{ timestamp: "desc" }, { id: "asc" }];

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      client.inventoryLedger.findMany({
        where,
        include: includeRelations,
        orderBy: sort,
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
    orderBy: sort,
  });
};

/** Totals across the whole filtered set, not the page. */
const summariseInventoryLedgers = async (where = {}, tx) => {
  const client = db(tx);
  const [aggregate, byMovementType] = await Promise.all([
    client.inventoryLedger.aggregate({
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    }),
    client.inventoryLedger.groupBy({
      by: ["movementType"],
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    }),
  ]);

  return {
    total: aggregate._count._all,
    totalQuantity: aggregate._sum.quantity ?? 0,
    byMovementType: Object.fromEntries(
      byMovementType.map((row) => [
        row.movementType,
        { count: row._count._all, quantity: row._sum.quantity ?? 0 },
      ]),
    ),
  };
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
  summariseInventoryLedgers,
  createInventoryLedger,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  deleteInventoryLedger,
};
