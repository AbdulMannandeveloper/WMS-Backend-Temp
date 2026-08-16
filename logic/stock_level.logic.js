const stockLevelRepository = require("../repositories/stock_level.repository");
const productRepository = require("../repositories/product.repository");
const warehouseLocationRepository = require("../repositories/warehouse_location.repository");

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

const createStockLevel = async (stockLevelData, tx) => {
  if (!stockLevelData.productId || !stockLevelData.locationId) {
    throw new Error(
      "Product ID and Location ID are required to create a stock level entry.",
    );
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

  if (stockLevelData.currentQuantity) {
    if (stockLevelData.currentQuantity < 0) {
      throw new Error("Current quantity cannot be negative.");
    }
    stockLevelData.arrivedTodayQuantity = stockLevelData.currentQuantity;
  }

  const result = await stockLevelRepository.createStockLevel(stockLevelData, tx);
  return await enrichStockLevelsWithZoneShelfBin(result);
};

const getAllStockLevels = async (pagination) => {
  const { items, total } = await stockLevelRepository.getAllStockLevels(pagination);
  const enriched = await enrichStockLevelsWithZoneShelfBin(items);
  if (pagination && pagination.take != null) {
    return { items: enriched, total };
  }
  return enriched;
};

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

const updateStockLevel = async (id, updateData, tx) => {
  if (updateData.productId) {
    const product = await productRepository.getProductById(
      updateData.productId,
    );
    if (!product) {
      throw new Error("Product not found.");
    }
  }

  if (updateData.locationId) {
    const location =
      await warehouseLocationRepository.getWarehouseLocationFirstByField(
        "id",
        updateData.locationId,
      );
    if (!location) {
      throw new Error("Location not found.");
    }
  }

  const currentStockLevel = await stockLevelRepository.getStockLevelById(id, tx);
  if (updateData.quantityToChange) {
    updateData.currentQuantity =
      currentStockLevel.currentQuantity + updateData.quantityToChange;
    delete updateData.quantityToChange;
  }
  if (updateData.currentQuantity !== undefined) {
    if (updateData.currentQuantity < 0) {
      throw new Error("Not enough stock available to fulfill the request.");
    }

    const product = await productRepository.getProductById(currentStockLevel.productId);
    const threshold = product ? product.thresholdLimit : 0;
    if (updateData.currentQuantity < threshold) {
      console.log(
        `Stock level for product ${currentStockLevel.productId} at location ${currentStockLevel.locationId} is below threshold.`,
      );
    }

    if (updateData.currentQuantity > currentStockLevel.currentQuantity) {
      const baseArrived = updateData.arrivedTodayQuantity !== undefined
        ? updateData.arrivedTodayQuantity
        : (currentStockLevel.arrivedTodayQuantity || 0);
      updateData.arrivedTodayQuantity = baseArrived + (updateData.currentQuantity - currentStockLevel.currentQuantity);
    }
  }

  const result = await stockLevelRepository.updateStockLevel(id, updateData, tx);
  return await enrichStockLevelsWithZoneShelfBin(result);
};

const updateStockLevelByProductAndLocation = async (
  productId,
  locationId,
  updateData,
  tx,
) => {
  const stockLevel = await stockLevelRepository.getStockLevelByProductAndLocation(
    productId,
    locationId,
    tx,
  );
  if (!stockLevel) {
    throw new Error("Stock level entry not found for the given product and location.");
  }
  return await updateStockLevel(stockLevel.id, updateData, tx);
};

const deleteStockLevel = async (id) => {
  return await stockLevelRepository.deleteStockLevel(id);
};

module.exports = {
  createStockLevel,
  getAllStockLevels,
  getStockLevelByField,
  getStockLevelByProductAndLocation,
  updateStockLevel,
  updateStockLevelByProductAndLocation,
  deleteStockLevel,
};
