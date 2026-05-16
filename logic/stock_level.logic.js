const stockLevelRepository = require("../repositories/stock_level.repository");
const productRepository = require("../repositories/product.repository");
// const locationRepository = require('../repositories/location.repository');

const createStockLevel = async (stockLevelData) => {
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

  // --------------------------------------------------------------------------
  // Location logic is currently commented out to avoid circular dependency issues.
  // --------------------------------------------------------------------------

  //   const location = await locationRepository.getLocationById(stockLevelData.locationId);
  //   if (!location) {
  //     throw new Error('Location not found.');
  //   }

  // --------------------------------------------------------------------------

  if (stockLevelData.currentQuantity < 0) {
    throw new Error("Current quantity cannot be negative.");
  }

  return await stockLevelRepository.createStockLevel(stockLevelData);
};

const getAllStockLevels = async () => {
  return await stockLevelRepository.getAllStockLevels();
};

const getStockLevelByField = async (field, value) => {
  return await stockLevelRepository.getStockLevelByField(field, value);
};

const updateStockLevel = async (id, updateData) => {
  if (
    updateData.currentQuantity !== undefined &&
    updateData.currentQuantity < 0
  ) {
    throw new Error("Current quantity cannot be negative.");
  }

  // If productId or locationId is being updated, validate them
  if (updateData.productId) {
    const product = await productRepository.getProductById(
      updateData.productId,
    );
    if (!product) {
      throw new Error("Product not found.");
    }
  }

  // --------------------------------------------------------------------------
  // Location logic is currently commented out to avoid circular dependency issues.
  // --------------------------------------------------------------------------

  // if (updateData.locationId) {
  //   const location = await locationRepository.getLocationById(updateData.locationId);
  //   if (!location) {
  //     throw new Error('Location not found.');
  //   }
  // }

  // --------------------------------------------------------------------------

  // Logic to notify/send alerts if stock level falls below the threshold
  const updatedStockLevel = await stockLevelRepository.getStockLevelById(id);
  if (
    updateData.currentQuantity !== undefined &&
    updateData.currentQuantity < updatedStockLevel.threshold
  ) {
    // Implement alert/notification logic here (e.g., send email, trigger webhook, etc.)
    console.log(
      `Stock level for product ${updatedStockLevel.productId} at location ${updatedStockLevel.locationId} is below threshold.`,
    );
  }

  return await stockLevelRepository.updateStockLevel(id, updateData);
};

const updateStockLevelByProductAndLocation = async (
  productId,
  locationId,
  updateData,
) => {
  if (
    updateData.currentQuantity !== undefined &&
    updateData.currentQuantity < 0
  ) {
    throw new Error("Current quantity cannot be negative.");
  }
  return await stockLevelRepository.updateStockLevelByProductAndLocation(
    productId,
    locationId,
    updateData,
  );
};

const deleteStockLevel = async (id) => {
  return await stockLevelRepository.deleteStockLevel(id);
};

module.exports = {
  createStockLevel,
  getAllStockLevels,
  getStockLevelByField,
  updateStockLevel,
  updateStockLevelByProductAndLocation,
  deleteStockLevel,
};
