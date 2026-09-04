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
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const billingServices = require("./billing_services");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");
const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");

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

/**
 * Returns some or all of a dispatched line to the shelf.
 *
 * Goods that went out and came back. Only from a DISPATCHED shipment: before
 * that, unpick and cancel already put reserved stock back, and a second path
 * doing the same job is how the two end up disagreeing about what is on the
 * shelf.
 *
 * The stock goes back to the bin it was picked from, which the line already
 * records, and is logged as a RETURN rather than a CHECKIN — goods coming back
 * from a customer and goods arriving from a supplier are different events, and
 * folding them together makes every inbound report wrong.
 *
 * THE INVOICE IS NOT TOUCHED. No line is added, amended or reversed, and the
 * total is not recalculated. The dispatch happened and was charged for; what
 * happens to the goods afterwards is a separate commercial conversation, and
 * silently crediting an invoice from a warehouse action is not this system's
 * decision to make.
 */
/**
 * Takes some of a dispatched line back.
 *
 * Two things stay true whatever else happens: the stock goes back on the shelf,
 * and **the shipment's own invoice line is never touched**. What was dispatched
 * was dispatched, and rewriting a charge already raised is how an invoice stops
 * matching what the client was told.
 *
 * The return may carry its own cost, which is a separate line rather than an
 * adjustment to the old one. It is optional twice: a client with no agreed
 * ITEM_RETURN rate is never charged, and even with one the admin decides per
 * return — so `chargeReturn` defaults to false. Forgetting to untick would
 * bill a client for a return meant to be absorbed, and an unnoticed charge is
 * worse than an unnoticed omission.
 *
 * @param {{ chargeReturn?: boolean }} [options]
 */
const returnShipmentItem = async (
  id,
  quantity,
  reason,
  actorUserId,
  { chargeReturn = false } = {},
) => {
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

  if (shipment.status !== "DISPATCHED") {
    throw new Error(
      `Only a dispatched shipment can have items returned — this one is ${shipment.status}. Use unpick or cancel instead.`,
    );
  }

  const alreadyReturned = item.returnedQuantity ?? 0;
  const outstanding = item.quantity - alreadyReturned;

  const amount = Number(quantity);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Return quantity must be a whole number above zero.");
  }
  if (amount > outstanding) {
    throw new Error(
      alreadyReturned > 0
        ? `Only ${outstanding} of this line is still out — ${alreadyReturned} of ${item.quantity} has already been returned.`
        : `Cannot return ${amount}; the line was only ${item.quantity}.`,
    );
  }

  return await prisma.$transaction(async (tx) => {
    const updated = await shipmentItemRepository.updateShipmentItem(
      id,
      { returnedQuantity: alreadyReturned + amount },
      tx,
    );

    // The ledger applies the stock change itself, the same way CHECKOUT does at
    // dispatch — putting it back here as well would credit the shelf twice.
    await inventoryLedgerLogic.createInventoryLedger(
      {
        productId: item.productId,
        userId: actorUserId,
        movementType: "RETURN",
        quantity: amount,
        toLocationId: item.sourceLocationId,
        referenceId: item.shipmentId,
        notes: reason ? String(reason) : "Returned after dispatch",
      },
      { tx },
    );

    // The return's own cost, when there is one and it was asked for. A
    // separate line: the dispatch charge above it stays exactly as raised.
    let returnCharge = null;
    if (chargeReturn) {
      const rate = await billingServices.getReturnRateForClient(
        shipment.clientId,
        tx,
      );

      if (rate && Number(rate.unitPrice) > 0) {
        const unitPrice = Number(rate.unitPrice);
        const invoice = await billingServices.resolveOpenInvoiceFor(
          shipment.clientId,
          tx,
        );

        await invoiceLineItemRepository.createInvoiceLineItem(
          {
            invoiceId: invoice.id,
            clientServiceId: rate.clientService.id,
            quantity: amount,
            unitPrice,
            totalPrice: Number((amount * unitPrice).toFixed(2)),
            description: `Return handling — ${amount} item(s) from shipment ${shipment.reference}`,
            dateOfService: new Date(),
            itemType: "MANUAL_CHARGE",
          },
          tx,
        );

        await monthlyInvoiceRepository.recalculateInvoiceTotal(invoice.id, tx);
        returnCharge = Number((amount * unitPrice).toFixed(2));
      }
      // No rate: silently not charged is wrong, so the caller is told by the
      // returnCharge staying null and the audit recording the ask.
    }

    if (actorUserId) {
      await auditLogLogic
        .createAuditLog(actorUserId, "SHIPMENT_ITEM_RETURNED", {
          shipmentItemId: id,
          shipmentId: item.shipmentId,
          productId: item.productId,
          toLocationId: item.sourceLocationId,
          quantity: amount,
          returnedTotal: alreadyReturned + amount,
          ofLineQuantity: item.quantity,
          reason: reason ?? null,
          // The dispatch charge is never rewritten. A return fee, when one
          // applies, is its own line.
          dispatchChargeChanged: false,
          chargeRequested: chargeReturn,
          returnCharge,
        })
        .catch((err) => console.error("Audit log error:", err.message));
    }

    return { ...updated, returnCharge };
  });
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
  returnShipmentItem,
  deleteShipmentItem,
};
