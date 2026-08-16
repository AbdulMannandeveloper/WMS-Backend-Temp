const { prisma } = require('../lib/prisma');

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

const getAllStockLevels = async ({ skip, take } = {}, tx) => {
  const client = db(tx);
  const [items, total] = await Promise.all([
    client.stockLevel.findMany({
      include: includeRelations,
      ...(take != null ? { skip: skip || 0, take } : {}),
      orderBy: { id: 'asc' },
    }),
    client.stockLevel.count(),
  ]);
  return { items, total };
};

const getStockLevelByField = async (field, value, tx) => {
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
  createStockLevel,
  getAllStockLevels,
  getStockLevelById,
  getStockLevelByField,
  getStockLevelByProductAndLocation,
  updateStockLevel,
  deleteStockLevel,
  reserveStockAtomically,
  releaseReservedStockAtomically,
  checkoutStockAtomically,
  decreaseAvailableStockAtomically,
  increaseOrCreateStockAtomically,
};
