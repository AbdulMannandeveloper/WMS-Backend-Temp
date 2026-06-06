const shipmentItemRepository = require("../repositories/shipment_item.repository");

const shipmentLogic = require("./shipment.logic");
const productLogic = require("./product.logic");
const stockLevelLogic = require("./stock_level.logic");

const createShipmentItem = async (data) => {
  // Check for required fields
  if (
    !data.shipmentId ||
    !data.productId ||
    !data.sourceLocationId ||
    !data.quantity
  ) {
    throw new Error("Missing required fields");
  }

  // Validate shipmentId, productId, and sourceLocationId
  const shipment = await shipmentLogic.getShipmentByField(
    "id",
    data.shipmentId,
  );
  const product = await productLogic.getProductById(data.productId);
  const sourceStock = await stockLevelLogic.getStockLevelByProductAndLocation(
    data.productId,
    data.sourceLocationId,
  );

  if (!shipment) {
    throw new Error("Shipment not found");
  }
  if (!product) {
    throw new Error("Product not found");
  }
  if (!sourceStock) {
    throw new Error("Source stock not found");
  }

  // If status is not provided, default to 'PENDING'
  if (!data.status) {
    data.status = "PENDING";
  }

  // Handle the reservation of inventory if the status is 'PENDING'
  if (data.status === "PENDING") {
    // Implement inventory reservation logic here
    // For example, you might want to check if the required quantity is available and reserve it
    if (sourceStock.currentQuantity < data.quantity) {
      throw new Error("Insufficient inventory available");
    }
    // Update the reserved quantity in the stock level. Current (total) quantity will be adjusted only after the shipment is completed/shipped.
    await stockLevelLogic.updateStockLevel(sourceStock.id, {
      reservedQuantity: sourceStock.reservedQuantity + data.quantity,
    });
  }
  return await shipmentItemRepository.createShipmentItem(data);
};

const getShipmentItemsByField = async (field, value) => {
  return await shipmentItemRepository.getShipmentItemsByField(field, value);
};

const updateShipmentItem = async (id, data) => {
  if (data.shipmentId) {
    const shipment = await shipmentLogic.getShipmentByField(
      "id",
      data.shipmentId,
    );
    if (!shipment) {
      throw new Error("Shipment not found");
    }
  }

  const existingItem = await shipmentItemRepository.getShipmentItemsByField(
    "id",
    id,
  );
  if (data.productId) {
    const product = await productLogic.getProductById(data.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    // If both Product and Location are being updated, validate the new combination
    if (data.sourceLocationId) {
      const sourceStock =
        await stockLevelLogic.getStockLevelByProductAndLocation(
          data.productId,
          data.sourceLocationId,
        );
      if (!sourceStock) {
        throw new Error("Source stock not found");
      }
    }

    // If only Product is being updated, validate the existing source location with the new product
    const sourceStock = await stockLevelLogic.getStockLevelByProductAndLocation(
      data.productId,
      existingItem.sourceLocationId,
    );
    if (!sourceStock) {
      throw new Error("Source stock not found");
    }
  }

  // If only Location is being updated, validate the existing product with the new location
  if (data.sourceLocationId) {
    const sourceStock = await stockLevelLogic.getStockLevelByProductAndLocation(
      existingItem.productId,
      data.sourceLocationId,
    );
    if (!sourceStock) {
      throw new Error("Source stock not found");
    }
  }

  if (data.status) {
    if (data.status === "PICKED" && existingItem.status !== "PENDING") {
      throw new Error(
        "Only items with PENDING status can be updated to PICKED.",
      );
    }
    if (data.status === "READY" && existingItem.status !== "PICKED") {
      throw new Error("Only items with PICKED status can be updated to READY.");
    }
  }
  return await shipmentItemRepository.updateShipmentItem(id, data);
};

const deleteShipmentItem = async (id) => {
  return await shipmentItemRepository.deleteShipmentItem(id);
};

module.exports = {
  createShipmentItem,
  getShipmentItemsByField,
  updateShipmentItem,
  deleteShipmentItem,
};
