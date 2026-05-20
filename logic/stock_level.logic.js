const stockLevelRepository = require("../repositories/stock_level.repository");
const productRepository = require("../repositories/product.repository");
const warehosueLocationRepository = require("../repositories/warehouse_location.repository");

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

  const location =
    await warehouseLocationRepository.getWarehouseLocationByField(
      "locationId",
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

  return await stockLevelRepository.createStockLevel(stockLevelData);
};

const getAllStockLevels = async () => {
  return await stockLevelRepository.getAllStockLevels();
};

const getStockLevelByField = async (field, value) => {
  return await stockLevelRepository.getStockLevelByField(field, value);
};

const getStockLevelByProductAndLocation = async (productId, locationId) => {
  return await stockLevelRepository.getStockLevelByProductAndLocation(
    productId,
    locationId,
  );
};

const updateStockLevel = async (id, updateData) => {
  // If productId or locationId is being updated, validate them
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
      await warehouseLocationRepository.getWarehouseLocationByField(
        "locationId",
        updateData.locationId,
      );
    if (!location) {
      throw new Error("Location not found.");
    }
  }

  const currentStockLevel = await stockLevelRepository.getStockLevelById(id);
  // If quantityToChange is provided, calculate the new currentQuantity
  if (updateData.quantityToChange) {
    updateData.currentQuantity =
      currentStockLevel.currentQuantity + updateData.quantityToChange;
    if (updateData.currentQuantity > 0) {
      updateData.arrivedTodayQuantity += updateData.quantityToChange;
    }
    delete updateData.quantityToChange;
  }
  // If currentQuantity is being updated directly, validate it and adjust arrivedTodayQuantity if necessary
  if (updateData.currentQuantity !== undefined) {
    // Validate that the new currentQuantity is not negative
    if (updateData.currentQuantity < 0) {
      throw new Error("Not enough stock available to fulfill the request.");
    }

    // Logic to notify/send alerts if stock level falls below the threshold
    if (updateData.currentQuantity < currentStockLevel.threshold) {
      // Implement alert/notification logic here (e.g., send email, trigger webhook, etc.)
      console.log(
        `Stock level for product ${currentStockLevel.productId} at location ${currentStockLevel.locationId} is below threshold.`,
      );
    }

    // If currentQuantity is being updated directly, we might want to adjust arrivedTodayQuantity accordingly
    if (updateData.currentQuantity > currentStockLevel.currentQuantity) {
      updateData.arrivedTodayQuantity +=
        updateData.currentQuantity - currentStockLevel.currentQuantity;
    }
  }

  return await stockLevelRepository.updateStockLevel(id, updateData);
};

const updateStockLevelByProductAndLocation = async (
  productId,
  locationId,
  updateData,
) => {
  // If productId or locationId is being updated, validate them
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
      await warehouseLocationRepository.getWarehouseLocationByField(
        "locationId",
        updateData.locationId,
      );
    if (!location) {
      throw new Error("Location not found.");
    }
  }

  const currentStockLevel =
    await stockLevelRepository.getStockLevelByProductAndLocation(
      productId,
      locationId,
    );
  // If quantityToChange is provided, calculate the new currentQuantity
  if (updateData.quantityToChange) {
    updateData.currentQuantity =
      currentStockLevel.currentQuantity + updateData.quantityToChange;
    if (updateData.currentQuantity > 0) {
      updateData.arrivedTodayQuantity += updateData.quantityToChange;
    }
    delete updateData.quantityToChange;
  }
  // If currentQuantity is being updated directly, validate it and adjust arrivedTodayQuantity if necessary
  if (updateData.currentQuantity !== undefined) {
    // Validate that the new currentQuantity is not negative
    if (updateData.currentQuantity < 0) {
      throw new Error("Not enough stock available to fulfill the request.");
    }

    // Logic to notify/send alerts if stock level falls below the threshold
    if (updateData.currentQuantity < currentStockLevel.threshold) {
      // Implement alert/notification logic here (e.g., send email, trigger webhook, etc.)
      console.log(
        `Stock level for product ${currentStockLevel.productId} at location ${currentStockLevel.locationId} is below threshold.`,
      );
    }

    // If currentQuantity is being updated directly, we might want to adjust arrivedTodayQuantity accordingly
    if (updateData.currentQuantity > currentStockLevel.currentQuantity) {
      updateData.arrivedTodayQuantity +=
        updateData.currentQuantity - currentStockLevel.currentQuantity;
    }
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
  getStockLevelByProductAndLocation,
  updateStockLevel,
  updateStockLevelByProductAndLocation,
  deleteStockLevel,
};
