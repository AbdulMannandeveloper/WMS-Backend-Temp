const stockLevelRepository = require("../repositories/stock_level.repository");
const {
  parseBoolean,
  parseUuid,
  rangeFilter,
  searchFilter,
} = require('../utils/queryFilters');
const productRepository = require("../repositories/product.repository");
const warehouseLocationRepository = require("../repositories/warehouse_location.repository");
const auditLogLogic = require("./audit_log.logic");

/**
 * A stock row's quantities are the running total of its ledger. Set by hand,
 * they are units that appeared or vanished with no movement to say so — so the
 * stock routes never write them. Units arrive by a check-in or opening stock,
 * and leave by a dispatch, a move or a write-off, each of which records itself.
 */
const QUANTITY_FIELDS = ["currentQuantity", "reservedQuantity", "arrivedTodayQuantity"];

const MOVEMENTS_ONLY =
  "Stock quantities change only through stock movements, so every unit has a record. Check stock in, move it or write it off from the Inventory page instead.";

const failWith = (status, message) => Object.assign(new Error(message), { status });

const enrichStockLevelsWithZoneShelfBin = async (data) => {
  if (!data) return data;

  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];

  const locationsToEnrich = items.filter(item => item && item.location && item.locationId);
  if (locationsToEnrich.length === 0) return data;

  const locations = await warehouseLocationRepository.getAllWarehouseLocations();
  const locationMap = new Map(locations.map(loc => [loc.id, loc]));

  const resolveHierarchy = (locId) => {
    let zone = null;
    let shelf = null;
    let bin = null;

    let current = locationMap.get(locId);
    while (current) {
      const className = current.locationClass?.name?.toUpperCase();
      if (className === 'ZONE') {
        zone = current.locationName;
      } else if (className === 'SHELF') {
        shelf = current.locationName;
      } else if (className === 'BIN') {
        bin = current.locationName;
      }

      current = current.parentLocationId ? locationMap.get(current.parentLocationId) : null;
    }

    return { zone, shelf, bin };
  };

  for (const item of items) {
    if (item && item.location) {
      const hierarchy = resolveHierarchy(item.locationId);
      item.location.zone = hierarchy.zone;
      item.location.shelf = hierarchy.shelf;
      item.location.bin = hierarchy.bin;
    }
  }

  return isArray ? items : items[0];
};

// Opened empty, and never in a deactivated location; see QUANTITY_FIELDS.
const createStockLevel = async (stockLevelData, tx) => {
  if (!stockLevelData.productId || !stockLevelData.locationId) {
    throw new Error(
      "Product ID and Location ID are required to create a stock level entry.",
    );
  }
  if (QUANTITY_FIELDS.some((field) => Number(stockLevelData[field] ?? 0) !== 0)) {
    throw failWith(409, MOVEMENTS_ONLY);
  }

  const product = await productRepository.getProductById(
    stockLevelData.productId,
  );
  if (!product) {
    throw new Error("Product not found.");
  }

  const location =
    await warehouseLocationRepository.getWarehouseLocationFirstByField(
      "id",
      stockLevelData.locationId,
    );
  if (!location) {
    throw new Error("Location not found.");
  }
  if (location.isActive === false) {
    throw failWith(409, `${location.locationName} has been deactivated. Choose another location.`);
  }

  const result = await stockLevelRepository.createStockLevel(
    { productId: stockLevelData.productId, locationId: stockLevelData.locationId },
    tx,
  );
  return await enrichStockLevelsWithZoneShelfBin(result);
};

/** What the stock list may be narrowed by. Shared with /summary. */
const STOCK_LEVEL_LIST_SPEC = {
  filters: [
    (q) =>
      searchFilter(q.search, [
        'product.skuCode',
        'product.productName',
        'location.locationName',
      ]),
    (q) => {
      const productId = parseUuid(q.productId, 'productId');
      return productId ? { productId } : undefined;
    },
    (q) => {
      const locationId = parseUuid(q.locationId, 'locationId');
      return locationId ? { locationId } : undefined;
    },
    (q) => {
      const range = rangeFilter(q.quantityMin, q.quantityMax, {
        label: 'quantity',
        integer: true,
      });
      return range ? { currentQuantity: range } : undefined;
    },
    (q) => {
      const hasReserved = parseBoolean(q.hasReserved, 'hasReserved');
      if (hasReserved === undefined) return undefined;
      return hasReserved
        ? { reservedQuantity: { gt: 0 } }
        : { reservedQuantity: { lte: 0 } };
    },
  ],
  sort: {
    allowed: {
      productName: (order) => ({ product: { productName: order } }),
      skuCode: (order) => ({ product: { skuCode: order } }),
      locationName: (order) => ({ location: { locationName: order } }),
      currentQuantity: (order) => ({ currentQuantity: order }),
      reservedQuantity: (order) => ({ reservedQuantity: order }),
      arrivedTodayQuantity: (order) => ({ arrivedTodayQuantity: order }),
    },
    defaultSort: { field: 'productName', order: 'asc' },
    tiebreaker: [{ id: 'asc' }],
  },
};

/** One client sees one client. A relation filter, composed like any other. */
const clientScopeClause = (clientId) => ({ product: { clientId } });

const getAllStockLevels = async (where, options) => {
  const { items, total } = await stockLevelRepository.getAllStockLevels(
    where,
    options,
  );
  return { items: await enrichStockLevelsWithZoneShelfBin(items), total };
};

const summariseStockLevels = async (where) =>
  await stockLevelRepository.summariseStockLevels(where);

const getStockLevelByField = async (field, value) => {
  const result = await stockLevelRepository.getStockLevelByField(field, value);
  return await enrichStockLevelsWithZoneShelfBin(result);
};

const getStockLevelByProductAndLocation = async (productId, locationId, tx) => {
  const result = await stockLevelRepository.getStockLevelByProductAndLocation(
    productId,
    locationId,
    tx,
  );
  return await enrichStockLevelsWithZoneShelfBin(result);
};

/**
 * The edit routes stay, behind the grant they always had, to say where to go
 * instead: a row that exists is refused, one that does not is not found.
 */
const refuseStockEdit = async ({ id, productId, locationId }) => {
  const stockLevel = id
    ? await stockLevelRepository.getStockLevelById(id)
    : await stockLevelRepository.getStockLevelByProductAndLocation(productId, locationId);
  if (!stockLevel) throw failWith(404, "Stock level not found.");
  throw failWith(409, MOVEMENTS_ONLY);
};

/**
 * Only an empty row goes. Units in it are moved or written off first, which
 * records them; deleting the row with them would not. The delete is
 * conditional on the row still being empty, so stock checked in between the
 * look and the delete keeps it.
 */
const deleteStockLevel = async (id, actorUserId) => {
  const stockLevel = await stockLevelRepository.getStockLevelById(id);
  if (!stockLevel) throw failWith(404, "Stock level not found.");

  const label = `${stockLevel.product?.skuCode ?? "This product"} at ${stockLevel.location?.locationName ?? "this location"}`;
  if (stockLevel.currentQuantity !== 0 || stockLevel.reservedQuantity !== 0) {
    const reserved = stockLevel.reservedQuantity
      ? `, ${stockLevel.reservedQuantity} of them reserved for shipments`
      : "";
    throw failWith(
      409,
      `${label} still holds ${stockLevel.currentQuantity} unit(s)${reserved}. Move them or write them off first, then delete the empty row.`,
    );
  }
  if (!(await stockLevelRepository.deleteEmptyStockLevel(id))) {
    throw failWith(409, `${label} has just taken stock, so it was not deleted.`);
  }

  await auditLogLogic.auditQuietly(actorUserId, "DELETE_STOCK_LEVEL", {
    stockLevelId: id,
    productId: stockLevel.productId,
    skuCode: stockLevel.product?.skuCode,
    locationId: stockLevel.locationId,
    locationName: stockLevel.location?.locationName,
  });
  return stockLevel;
};

module.exports = {
  STOCK_LEVEL_LIST_SPEC,
  clientScopeClause,
  summariseStockLevels,
  createStockLevel,
  getAllStockLevels,
  getStockLevelByField,
  getStockLevelByProductAndLocation,
  refuseStockEdit,
  deleteStockLevel,
};
