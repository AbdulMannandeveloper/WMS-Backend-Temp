const { prisma } = require("../lib/prisma");
const shipmentItemRepository = require("../repositories/shipment_item.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");

const shipmentLogic = require("./shipment.logic");
const productLogic = require("./product.logic");
const stockLevelLogic = require("./stock_level.logic");

const createShipmentItem = async (data) => {
  if (
    !data.shipmentId ||
    !data.productId ||
    !data.sourceLocationId ||
    !data.quantity
  ) {
    throw new Error("Missing required fields");
  }

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

  if (product.isDeactivated) {
    throw new Error("Cannot add a deactivated product to a shipment.");
  }

  if (!data.status) {
    data.status = "PENDING";
  }

  return prisma.$transaction(async (tx) => {
    if (data.status === "PENDING") {
      const reserved = await stockLevelRepository.reserveStockAtomically(
        sourceStock.id,
        data.quantity,
        tx,
      );
      if (reserved === 0) {
        const availableQuantity =
          sourceStock.currentQuantity - sourceStock.reservedQuantity;
        throw new Error(
          `Insufficient available inventory. Available: ${availableQuantity}, Requested: ${data.quantity}.`,
        );
      }
    }
    return await shipmentItemRepository.createShipmentItem(data, tx);
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });
};

const getShipmentItemsByField = async (field, value, tx) => {
  return await shipmentItemRepository.getShipmentItemsByField(field, value, tx);
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

  const existingItems = await shipmentItemRepository.getShipmentItemsByField(
    "id",
    id,
  );
  const existingItem = Array.isArray(existingItems)
    ? existingItems[0]
    : existingItems;
  if (!existingItem) {
    throw new Error("Shipment item not found");
  }

  if (data.productId) {
    const product = await productLogic.getProductById(data.productId);
    if (!product) {
      throw new Error("Product not found");
    }

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

    const sourceStock = await stockLevelLogic.getStockLevelByProductAndLocation(
      data.productId,
      existingItem.sourceLocationId,
    );
    if (!sourceStock) {
      throw new Error("Source stock not found");
    }
  }

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
