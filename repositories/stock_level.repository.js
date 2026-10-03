const { prisma } = require('../lib/prisma');
const { assertAllowedField } = require('../utils/pick');

// Every caller hardcodes its field today, so the dynamic key below has never
// been reachable from a request. That is a property of the callers, not of this
// function — and the list work is about to start putting query parameters near
// it. Named columns only, as attendance_log and inventory_ledger already do.
const STOCK_QUERY_FIELDS = ['id', 'productId', 'locationId'];

const includeRelations = {
  product: {
    include: {
      client: true,
    },
  },
  location: {
    include: {
      locationClass: true,
    },
  },
};

const db = (tx) => tx || prisma;

const createStockLevel = async (stockLevelData, tx) => {
  return await db(tx).stockLevel.create({
    data: stockLevelData,
    include: includeRelations,
  });
};

/**
 * @param {object} where - a Prisma where; {} matches everything. Client
 *   narrowing is part of this now rather than a separate argument, so it
 *   composes with the other filters instead of sitting beside them.
 * @param {object} [options]
 * @param {object[]} [options.orderBy]
 * @param {object} [options.pagination]
 */
const getAllStockLevels = async (where = {}, { orderBy, pagination, tx } = {}) => {
  const client = db(tx);
  // Product name, not id. The previous default ordered by a uuid primary key:
  // stable, which is what paging needs, and meaningless to anyone reading down
  // the column.
  const sort = orderBy || [
    { product: { productName: 'asc' } },
    { location: { locationName: 'asc' } },
    { id: 'asc' },
  ];

  const [items, total] = await Promise.all([
    client.stockLevel.findMany({
      where,
      include: includeRelations,
      orderBy: sort,
      ...(pagination && pagination.take != null
        ? { skip: pagination.skip || 0, take: pagination.take }
        : {}),
    }),
    client.stockLevel.count({ where }),
  ]);
  return { items, total };
};

/** Totals across the whole filtered set, not the page. */
const summariseStockLevels = async (where = {}, tx) => {
  const aggregate = await db(tx).stockLevel.aggregate({
    where,
    _count: { _all: true },
    _sum: { currentQuantity: true, reservedQuantity: true },
  });

  return {
    total: aggregate._count._all,
    totalUnits: aggregate._sum.currentQuantity ?? 0,
    totalReserved: aggregate._sum.reservedQuantity ?? 0,
  };
};

const getStockLevelByField = async (field, value, tx) => {
  assertAllowedField(field, STOCK_QUERY_FIELDS);
  return await db(tx).stockLevel.findMany({
    where: {
      [field]: value,
    },
    include: includeRelations,
  });
};

const getStockLevelByProductAndLocation = async (productId, locationId, tx) => {
  return await db(tx).stockLevel.findUnique({
    where: {
      productId_locationId: {
        productId: productId,
        locationId: locationId,
      },
    },
    include: includeRelations,
  });
};

const getStockLevelById = async (id, tx) => {
  return await db(tx).stockLevel.findUnique({
    where: { id },
    include: includeRelations,
  });
};

const updateStockLevel = async (id, updateData, tx) => {
  return await db(tx).stockLevel.update({
    where: { id },
    data: updateData,
    include: includeRelations,
  });
};

const deleteStockLevel = async (id, tx) => {
  return await db(tx).stockLevel.delete({
    where: { id },
  });
};

/** Deletes the row only while it holds nothing. Returns whether it did. */
const deleteEmptyStockLevel = async (id, tx) => {
  const { count } = await db(tx).stockLevel.deleteMany({
    where: { id, currentQuantity: 0, reservedQuantity: 0 },
  });
  return count > 0;
};

/**
 * Atomically reserve quantity if available stock is sufficient.
 * Uses a single conditional UPDATE to prevent oversell under concurrency.
 * @returns {number} rows updated (0 = insufficient stock)
 */
const reserveStockAtomically = async (stockLevelId, quantity, tx) => {
  return await db(tx).$executeRaw`
    UPDATE stock_levels
    SET reserved_quantity = reserved_quantity + ${quantity}
    WHERE id = ${stockLevelId}::uuid
      AND (current_quantity - reserved_quantity) >= ${quantity}
  `;
};

/**
 * Release previously reserved quantity (e.g. shipment delete).
 */
const releaseReservedStockAtomically = async (stockLevelId, quantity, tx) => {
  return await db(tx).$executeRaw`
    UPDATE stock_levels
    SET reserved_quantity = GREATEST(0, reserved_quantity - ${quantity})
    WHERE id = ${stockLevelId}::uuid
  `;
};

/**
 * CHECKOUT: decrement current + reserved atomically.
 */
const checkoutStockAtomically = async (productId, locationId, quantity, tx) => {
  return await db(tx).$executeRaw`
    UPDATE stock_levels
    SET current_quantity = current_quantity - ${quantity},
        reserved_quantity = reserved_quantity - ${quantity}
    WHERE product_id = ${productId}::uuid
      AND location_id = ${locationId}::uuid
      AND current_quantity >= ${quantity}
      AND reserved_quantity >= ${quantity}
  `;
};

/**
 * INTERNAL_MOVE from-side: decrement current if available (non-reserved) stock allows.
 */
const decreaseAvailableStockAtomically = async (productId, locationId, quantity, tx) => {
  return await db(tx).$executeRaw`
    UPDATE stock_levels
    SET current_quantity = current_quantity - ${quantity}
    WHERE product_id = ${productId}::uuid
      AND location_id = ${locationId}::uuid
      AND (current_quantity - reserved_quantity) >= ${quantity}
  `;
};

/**
 * CHECKIN / INTERNAL_MOVE to-side: increment or create stock row.
 * @param {{ countAsArrival?: boolean }} options - when true (CHECKIN), also bumps arrivedTodayQuantity
 */
const increaseOrCreateStockAtomically = async (
  productId,
  locationId,
  quantity,
  tx,
  options = {},
) => {
  const countAsArrival = Boolean(options.countAsArrival);
  const client = db(tx);
  const existing = await client.stockLevel.findUnique({
    where: {
      productId_locationId: { productId, locationId },
    },
  });

  if (existing) {
    return await client.stockLevel.update({
      where: { id: existing.id },
      data: {
        currentQuantity: existing.currentQuantity + quantity,
        ...(countAsArrival
          ? {
              arrivedTodayQuantity:
                (existing.arrivedTodayQuantity || 0) + quantity,
            }
          : {}),
      },
      include: includeRelations,
    });
  }

  return await client.stockLevel.create({
    data: {
      productId,
      locationId,
      currentQuantity: quantity,
      arrivedTodayQuantity: countAsArrival ? quantity : 0,
    },
    include: includeRelations,
  });
};

module.exports = {
  summariseStockLevels,
  createStockLevel,
  getAllStockLevels,
  getStockLevelById,
  getStockLevelByField,
  getStockLevelByProductAndLocation,
  updateStockLevel,
  deleteStockLevel,
  deleteEmptyStockLevel,
  reserveStockAtomically,
  releaseReservedStockAtomically,
  checkoutStockAtomically,
  decreaseAvailableStockAtomically,
  increaseOrCreateStockAtomically,
};
