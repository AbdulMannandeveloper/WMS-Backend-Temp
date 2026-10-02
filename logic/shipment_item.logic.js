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

/**
 * Adds a line to a shipment and reserves its stock.
 *
 * Pass `{ tx }` to join an outer transaction — createShipment does, so that a
 * shipment and all of its lines commit or roll back together.
 */
const createShipmentItem = async (data, options = {}) => {
  if (
    !data.shipmentId ||
    !data.productId ||
    !data.sourceLocationId ||
    !data.quantity
  ) {
    throw new Error("Missing required fields");
  }

  const run = async (tx) => {
    const shipment = await shipmentRepository.getShipmentByField(
      "id",
      data.shipmentId,
      tx,
    );
    const product = await productLogic.getProductById(data.productId);
    const sourceStock = await stockLevelRepository.getStockLevelByProductAndLocation(
      data.productId,
      data.sourceLocationId,
      tx,
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

    const status = data.status || "PENDING";

    if (status === "PENDING") {
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

    return await shipmentItemRepository.createShipmentItem(
      { ...data, status },
      tx,
    );
  };

  if (options.tx) {
    return run(options.tx);
  }

  return prisma.$transaction(run, {
    maxWait: 10_000,
    timeout: 30_000,
  });
};

const getShipmentItemsByField = async (field, value, tx) => {
  return await shipmentItemRepository.getShipmentItemsByField(field, value, tx);
};

/**
 * What may change on a line: how many, from which bin, and its own tracking id.
 *
 * The body used to go straight to the database, so a request could move a line
 * onto another shipment, swap its product, or set returnedQuantity — and a
 * quantity change left the reservation it was holding at the old figure. The
 * route has said all along that the parent shipment's state was checked
 * underneath; it was not.
 */
const ITEM_UPDATE_FIELDS = ["quantity", "sourceLocationId", "trackingId"];

/**
 * Edits a shipment line.
 *
 * - **tracking id** — any time but after cancellation, like the shipment's own
 *   (see setShipmentTracking): couriers issue it at the moment of dispatch.
 * - **quantity / source bin** — only while the shipment is PENDING and the line
 *   is not yet picked, and the reservation moves with it: the old one is handed
 *   back and the new one taken, in one transaction, refused if the bin cannot
 *   cover it.
 */
const updateShipmentItem = async (id, rawData, actorUserId) => {
  if (rawData.status !== undefined) {
    throw new Error(
      "Item status cannot be changed here. Use the pick or unpick actions.",
    );
  }

  const data = {};
  for (const field of ITEM_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawData, field)) {
      data[field] = rawData[field];
    }
  }

  const existingItems = await shipmentItemRepository.getShipmentItemsByField("id", id);
  const existingItem = Array.isArray(existingItems) ? existingItems[0] : existingItems;
  if (!existingItem) {
    throw new Error("Shipment item not found");
  }
  const shipment = await shipmentRepository.getShipmentByField("id", existingItem.shipmentId);
  if (!shipment) {
    throw new Error("Shipment not found");
  }

  if (Object.keys(data).length === 0) {
    return existingItem;
  }

  if (data.trackingId !== undefined && shipment.status === "CANCELLED") {
    throw new Error("A cancelled shipment's lines can no longer be changed.");
  }

  const nextQuantity = data.quantity !== undefined ? Number(data.quantity) : existingItem.quantity;
  const nextSourceId = data.sourceLocationId ?? existingItem.sourceLocationId;
  const movesStock =
    nextQuantity !== existingItem.quantity || nextSourceId !== existingItem.sourceLocationId;

  if (!movesStock) {
    return await shipmentItemRepository.updateShipmentItem(id, data);
  }

  if (shipment.status !== "PENDING" || existingItem.status !== "PENDING") {
    throw new Error(
      "Quantity and bin can only be changed on an unpicked line of a PENDING shipment.",
    );
  }
  if (!Number.isInteger(nextQuantity) || nextQuantity <= 0) {
    throw new Error("Quantity must be a whole number greater than zero.");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const oldStock = await stockLevelRepository.getStockLevelByProductAndLocation(
      existingItem.productId,
      existingItem.sourceLocationId,
      tx,
    );
    if (oldStock) {
      await stockLevelRepository.releaseReservedStockAtomically(oldStock.id, existingItem.quantity, tx);
    }

    const newStock = await stockLevelRepository.getStockLevelByProductAndLocation(
      existingItem.productId,
      nextSourceId,
      tx,
    );
    if (!newStock) {
      throw new Error("That product has no stock in the chosen bin.");
    }
    const reserved = await stockLevelRepository.reserveStockAtomically(newStock.id, nextQuantity, tx);
    if (reserved === 0) {
      throw new Error("Not enough free stock in that bin to cover this quantity.");
    }

    return await shipmentItemRepository.updateShipmentItem(
      id,
      { ...data, quantity: nextQuantity, sourceLocationId: nextSourceId },
      tx,
    );
  });

  if (actorUserId) {
    await auditLogLogic
      .createAuditLog(actorUserId, "SHIPMENT_ITEM_UPDATED", {
        shipmentItemId: id,
        shipmentId: existingItem.shipmentId,
        from: { quantity: existingItem.quantity, sourceLocationId: existingItem.sourceLocationId },
        to: { quantity: nextQuantity, sourceLocationId: nextSourceId },
      })
      .catch((err) => console.error("Audit log error:", err.message));
  }

  return updated;
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

// Returning a dispatched line lives in product_return.logic (recordLineReturn):
// the line's Return button books a return record like the Returns screen does,
// so every return has a RET number and is deleted from one place.

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
