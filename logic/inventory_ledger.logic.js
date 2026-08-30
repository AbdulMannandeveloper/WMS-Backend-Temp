const { prisma } = require("../lib/prisma");
const inventoryLedgerRepository = require("../repositories/inventory_ledger.repository");
const productRepository = require("../repositories/product.repository");
const locationRepository = require("../repositories/location.repository");
const userRepository = require("../repositories/user.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const shipmentRepository = require("../repositories/shipment.repository");

const validateLedgerInput = async (newData, tx) => {
  if (
    !newData.productId ||
    !newData.userId ||
    !newData.movementType ||
    !newData.quantity
  ) {
    throw new Error(
      "Product ID, user ID, movement type, and quantity are required to create an inventory ledger entry.",
    );
  }

  const product = await productRepository.getProductByField(
    "id",
    newData.productId,
  );
  if (!product) {
    throw new Error(`Provided product not found.`);
  }

  if (newData.quantity <= 0) {
    throw new Error("Quantity must be a positive number.");
  }

  if (newData.movementType === "CHECKOUT") {
    if (!newData.referenceId) {
      throw new Error(
        "Reference ID is required for CHECKOUT movements to link the inventory movement to a specific shipment or order.",
      );
    }
    const shipment = tx
      ? await tx.shipment.findFirst({ where: { id: newData.referenceId } })
      : await shipmentRepository.getShipmentByField("id", newData.referenceId);
    if (!shipment) {
      throw new Error(`Provided shipment not found.`);
    }
    if (shipment.status !== "DISPATCHED") {
      throw new Error(
        `Shipment must be in DISPATCHED status to be referenced in a checkout movement.`,
      );
    }
  }

  const movementRequirements = {
    CHECKIN: { requireFrom: false, requireTo: true },
    INTERNAL_MOVE: { requireFrom: true, requireTo: true },
    CHECKOUT: { requireFrom: true, requireTo: false },
    // Goods coming back after dispatch. Same shape as a CHECKIN — they arrive
    // into a bin from outside — but a distinct type, because a customer return
    // and a supplier delivery are different events and folding them together
    // makes every goods-in figure wrong.
    RETURN: { requireFrom: false, requireTo: true },
  };

  const req = movementRequirements[newData.movementType];
  if (!req) {
    throw new Error(`Unknown movement type: ${newData.movementType}`);
  }

  if (req.requireEither) {
    if (!newData.fromLocationId && !newData.toLocationId) {
      throw new Error(
        "At least one of fromLocationId or toLocationId is required for this movement type.",
      );
    }
  } else {
    if (req.requireFrom && !newData.fromLocationId) {
      throw new Error("fromLocationId is required for this movement type.");
    }
    if (req.requireTo && !newData.toLocationId) {
      throw new Error("toLocationId is required for this movement type.");
    }
  }

  if (newData.fromLocationId) {
    const fromLocation = await locationRepository.getLocationByField(
      "id",
      newData.fromLocationId,
    );
    if (!fromLocation) {
      throw new Error(`Provided from location not found.`);
    }
  }
  if (newData.toLocationId) {
    const toLocation = await locationRepository.getLocationByField(
      "id",
      newData.toLocationId,
    );
    if (!toLocation) {
      throw new Error(`Provided to location not found.`);
    }
  }
};

/**
 * Adjust stock levels based on a ledger entry using atomic conditional updates.
 * Runs inside the caller's transaction client.
 */
const adjustStockLevels = async (ledgerEntry, tx) => {
  if (ledgerEntry.movementType === "CHECKIN") {
    await stockLevelRepository.increaseOrCreateStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
      ledgerEntry.quantity,
      tx,
      { countAsArrival: true },
    );
    return true;
  }

  if (ledgerEntry.movementType === "RETURN") {
    // Back onto the shelf. Same shape as a CHECKIN, but deliberately NOT
    // counted as an arrival: arrivedTodayQuantity drives the goods-in view, and
    // a customer return is not a delivery.
    await stockLevelRepository.increaseOrCreateStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
      ledgerEntry.quantity,
      tx,
      { countAsArrival: false },
    );
    return true;
  }

  if (ledgerEntry.movementType === "CHECKOUT") {
    const updated = await stockLevelRepository.checkoutStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.fromLocationId,
      ledgerEntry.quantity,
      tx,
    );
    if (updated === 0) {
      throw new Error(
        `Insufficient reserved/current stock at the from location to perform the CHECKOUT movement.`,
      );
    }
    return true;
  }

  if (ledgerEntry.movementType === "INTERNAL_MOVE") {
    const decreased = await stockLevelRepository.decreaseAvailableStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.fromLocationId,
      ledgerEntry.quantity,
      tx,
    );
    if (decreased === 0) {
      throw new Error(
        `Cannot perform the INTERNAL_MOVE movement because the quantity exceeds the available stock at the from location.`,
      );
    }
    await stockLevelRepository.increaseOrCreateStockAtomically(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
      ledgerEntry.quantity,
      tx,
    );
    return true;
  }

  throw new Error(`Unsupported movement type: ${ledgerEntry.movementType}`);
};

/**
 * Create ledger + adjust stock in a single atomic transaction.
 * Pass `{ tx }` to join an outer interactive transaction (e.g. dispatch).
 */
const createInventoryLedger = async (newData, options = {}) => {
  const run = async (tx) => {
    await validateLedgerInput(newData, tx);
    const inventoryLedgerEntry =
      await inventoryLedgerRepository.createInventoryLedger(newData, tx);
    await adjustStockLevels(inventoryLedgerEntry, tx);
    return inventoryLedgerEntry;
  };

  if (options.tx) {
    return run(options.tx);
  }

  return prisma.$transaction(async (tx) => run(tx), {
    maxWait: 10_000,
    timeout: 30_000,
  });
};

const getAllInventoryLedgers = async (pagination) => {
  return await inventoryLedgerRepository.getAllInventoryLedgers({}, pagination);
};

const getInventoryLedgerByField = async (field, value) => {
  return await inventoryLedgerRepository.getInventoryLedgerByField(field, value);
};

const getLedgerWithFilters = async (
  { startDate, endDate, productId, clientId, movementType } = {},
  pagination,
) => {
  const filters = {};

  if (startDate || endDate) {
    filters.timestamp = {};
    if (startDate) filters.timestamp.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filters.timestamp.lte = end;
    }
  }

  if (productId) {
    filters.productId = productId;
  }

  if (movementType) {
    filters.movementType = movementType;
  }

  if (clientId) {
    const clientProducts = await productRepository.getProductsByField("clientId", clientId);
    const clientProductIds = clientProducts.map((p) => p.id);
    filters.productId = { in: clientProductIds };
  }

  return await inventoryLedgerRepository.getAllInventoryLedgers(filters, pagination);
};

const getInventoryLedgersByClientId = async (clientId, pagination) => {
  const clientProducts = await productRepository.getProductsByField("clientId", clientId);
  const clientProductIds = clientProducts.map((product) => product.id);

  if (clientProductIds.length === 0) {
    if (pagination && pagination.take != null) {
      return { items: [], total: 0 };
    }
    return [];
  }

  return await inventoryLedgerRepository.getAllInventoryLedgers(
    { productId: { in: clientProductIds } },
    pagination,
  );
};

const getDailyCheckoutSummary = async (dateStr) => {
  const date = dateStr ? new Date(dateStr) : new Date();
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const result = await inventoryLedgerRepository.getAllInventoryLedgers({
    movementType: "CHECKOUT",
    timestamp: { gte: startOfDay, lte: endOfDay },
  });
  const checkouts = Array.isArray(result) ? result : result.items;

  const grouped = {};
  for (const entry of checkouts) {
    const clientId = entry.product?.client?.id || "unknown";
    const companyName = entry.product?.client?.companyName || "Unknown Client";

    if (!grouped[clientId]) {
      grouped[clientId] = {
        clientId,
        companyName,
        totalItemsCheckedOut: 0,
        items: [],
      };
    }

    grouped[clientId].totalItemsCheckedOut += entry.quantity;
    grouped[clientId].items.push({
      ledgerId: entry.id,
      productId: entry.productId,
      productName: entry.product?.productName || "Unknown",
      skuCode: entry.product?.skuCode || null,
      quantity: entry.quantity,
      fromLocation: entry.fromLocation?.locationName || null,
      performedBy: entry.user
        ? `${entry.user.firstName} ${entry.user.lastName}`
        : "Unknown",
      timestamp: entry.timestamp,
      shipmentId: entry.referenceId || null,
    });
  }

  return Object.values(grouped);
};

// Unused enrichment helpers kept for potential future use
const enrichLedgerEntriesWithProductDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    const product = await productRepository.getProductByField(
      "id",
      ledger.productId,
    );
    ledger.productName = product ? product.name : "Unknown Product";
  }
  return ledgers;
};

const enrichLedgerEntriesWithLocationDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    if (ledger.fromLocationId) {
      const fromLocation = await locationRepository.getLocationByField(
        "id",
        ledger.fromLocationId,
      );
      ledger.fromLocationName = fromLocation
        ? fromLocation.name
        : "Unknown Location";
    }
    if (ledger.toLocationId) {
      const toLocation = await locationRepository.getLocationByField(
        "id",
        ledger.toLocationId,
      );
      ledger.toLocationName = toLocation ? toLocation.name : "Unknown Location";
    }
  }
  return ledgers;
};

const enrichLedgerEntriesWithUserDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    const user = await userRepository.getUserByField("id", ledger.userId);
    ledger.userName = user ? user.name : "Unknown User";
  }
  return ledgers;
};

module.exports = {
  createInventoryLedger,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  getInventoryLedgersByClientId,
  getLedgerWithFilters,
  getDailyCheckoutSummary,
  adjustStockLevels,
};
