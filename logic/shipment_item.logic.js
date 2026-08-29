const { prisma } = require("../lib/prisma");
const shipmentItemRepository = require("../repositories/shipment_item.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");

// Deliberately the repository, not ./shipment.logic. shipment.logic requires
// this module, so requiring it back creates a cycle: Node hands whichever loads
// second a partially-initialised exports object, and because module.exports is
// reassigned rather than mutated, that reference stays empty forever. It made
// getShipmentByField undefined here, which broke creating a shipment with items.
// A plain read belongs at the repository layer anyway.
const shipmentRepository = require("../repositories/shipment.repository");
const productLogic = require("./product.logic");
const stockLevelLogic = require("./stock_level.logic");
const auditLogLogic = require("./audit_log.logic");

const createShipmentItem = async (data) => {
  if (
    !data.shipmentId ||
    !data.productId ||
    !data.sourceLocationId ||
    !data.quantity
  ) {
    throw new Error("Missing required fields");
  }

  const shipment = await shipmentRepository.getShipmentByField(
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
    const shipment = await shipmentRepository.getShipmentByField(
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

  // Status moves through pickShipmentItem / unpickShipmentItem, which check the
  // parent shipment is still open. Letting it through here would reopen exactly
  // the hole this chunk closed on the shipment itself.
  if (data.status !== undefined) {
    throw new Error(
      "Item status cannot be changed here. Use the pick or unpick actions.",
    );
  }

  return await shipmentItemRepository.updateShipmentItem(id, data);
};

/** Loads one shipment item plus its parent shipment, or throws. */
const requireItemWithShipment = async (id) => {
  const items = await shipmentItemRepository.getShipmentItemsByField("id", id);
  const item = Array.isArray(items) ? items[0] : items;
  if (!item) {
    throw new Error("Shipment item not found.");
  }

  const shipment = await shipmentRepository.getShipmentByField(
    "id",
    item.shipmentId,
  );
  if (!shipment) {
    throw new Error("Shipment not found.");
  }

  // Picking is warehouse work on an open shipment. Once it is ready, dispatched
  // or cancelled, the lines are settled.
  if (shipment.status !== "PENDING") {
    throw new Error(
      `Items can only be picked while the shipment is PENDING — this one is ${shipment.status}.`,
    );
  }

  return { item, shipment };
};

/** PENDING → PICKED: the line is off the shelf and in the tote. */
const pickShipmentItem = async (id, actorUserId) => {
  const { item } = await requireItemWithShipment(id);

  if (item.status === "PICKED") {
    return item; // Already picked; scanning the same line twice is not an error.
  }

  const updated = await shipmentItemRepository.updateShipmentItem(id, {
    status: "PICKED",
  });

  if (actorUserId) {
    await auditLogLogic
      .createAuditLog(actorUserId, "SHIPMENT_ITEM_PICKED", {
        shipmentItemId: id,
        shipmentId: item.shipmentId,
        productId: item.productId,
        sourceLocationId: item.sourceLocationId,
        quantity: item.quantity,
      })
      .catch((err) => console.error("Audit log error:", err.message));
  }

  return updated;
};

/** PICKED → PENDING, for a mis-scan or a line put back on the shelf. */
const unpickShipmentItem = async (id, actorUserId) => {
  const { item } = await requireItemWithShipment(id);

  if (item.status === "PENDING") {
    return item;
  }

  const updated = await shipmentItemRepository.updateShipmentItem(id, {
    status: "PENDING",
  });

  if (actorUserId) {
    await auditLogLogic
      .createAuditLog(actorUserId, "SHIPMENT_ITEM_UNPICKED", {
        shipmentItemId: id,
        shipmentId: item.shipmentId,
        productId: item.productId,
      })
      .catch((err) => console.error("Audit log error:", err.message));
  }

  return updated;
};

const deleteShipmentItem = async (id) => {
  return await shipmentItemRepository.deleteShipmentItem(id);
};

module.exports = {
  createShipmentItem,
  getShipmentItemsByField,
  updateShipmentItem,
  pickShipmentItem,
  unpickShipmentItem,
  deleteShipmentItem,
};
