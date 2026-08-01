const inventoryLedgerRepository = require("../repositories/inventory_ledger.repository");
const productRepository = require("../repositories/product.repository");
const locationRepository = require("../repositories/location.repository");
const userRepository = require("../repositories/user.repository");
const clientRepository = require("../repositories/client.repository");

const stockLevelLogic = require("./stock_level.logic");
const shipmentLogic = require("./shipment.logic");

const createInventoryLedger = async (newData) => {
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

  // Validate that the referenced product exists
  const product = await productRepository.getProductByField(
    "id",
    newData.productId,
  );
  if (!product) {
    throw new Error(`Provided product not found.`);
  }

  // Validate that quantity is a positive number
  if (newData.quantity <= 0) {
    throw new Error("Quantity must be a positive number.");
  }

  // Check for reference ID if provided (e.g., for checkin, checkout)
  // Logic to check for reference ID would depend on the movement type and the business rules around it. For example, if it's a checkin movement, you might want to check that the reference ID corresponds to a valid purchase order. If it's a checkout movement, you might want to check that it corresponds to a valid sales order. This validation is important to ensure data integrity and traceability in the inventory system.
  // Validate the reference id
  // if (newData.referenceId) {
    // Depending on the movement type, the reference ID could point to different entities (e.g., purchase order for checkin, sales order for checkout)
    // You would need to implement logic to check the reference ID against the appropriate entity based on the movement type. For example:
    // if (newData.movementType === "CHECKIN") {
      // Check if the reference ID corresponds to a valid purchase order
    // }
  // }

  if (newData.movementType === "CHECKOUT") {
    if (!newData.referenceId) {
      throw new Error(
        "Reference ID is required for CHECKOUT movements to link the inventory movement to a specific shipment or order.",
      );
    }
    // Check if the reference ID corresponds to a valid shipment
    const shipment = await shipmentLogic.getShipmentByField(
      "id",
      newData.referenceId,
    );
    if (!shipment) {
      throw new Error(`Provided shipment not found.`);
    }
    if (shipment.status !== "DISPATCHED") {
      throw new Error(
        `Shipment must be in DISPATCHED status to be referenced in a checkout movement.`,
      );
    }
  }

  // Define movement type requirements for locations
  const movementRequirements = {
    CHECKIN: { requireFrom: false, requireTo: true },
    // PUTAWAY: { requireFrom: true, requireTo: true },
    INTERNAL_MOVE: { requireFrom: true, requireTo: true },
    // PICKING: { requireFrom: true, requireTo: false },
    CHECKOUT: { requireFrom: true, requireTo: false },
    // ADJUSTMENT: { requireFrom: false, requireTo: false, requireEither: true },
  };

  // Validate that movementType is one of the allowed values
  const req = movementRequirements[newData.movementType];
  if (!req) {
    throw new Error(`Unknown movement type: ${newData.movementType}`);
  }

  // If either-from-or-to is allowed (e.g., ADJUSTMENT)
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

  // Validate that the referenced location exists (if applicable)
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

  const inventoryLedgerEntry =
    await inventoryLedgerRepository.createInventoryLedger(newData);

  // Adjust stock levels based on the new ledger entry
  const stockAdjusted = await adjustStockLevels(inventoryLedgerEntry);

  if (!stockAdjusted) {
    await inventoryLedgerRepository.deleteInventoryLedger(
      inventoryLedgerEntry.id,
    ); // Rollback the ledger entry if stock adjustment fails
    throw new Error(
      "Failed to adjust stock levels based on the inventory ledger entry.",
    );
  }

  return inventoryLedgerEntry;
};

const getAllInventoryLedgers = async () => {
  // Repository now includes all relations — no manual enrichment needed
  return await inventoryLedgerRepository.getAllInventoryLedgers();
};

const getInventoryLedgerByField = async (field, value) => {
  return await inventoryLedgerRepository.getInventoryLedgerByField(field, value);
};

// US-058/059/060: Filter ledger by date range, productId, clientId, movementType
const getLedgerWithFilters = async ({ startDate, endDate, productId, clientId, movementType } = {}) => {
  const filters = {};

  // Date range filter (US-058)
  if (startDate || endDate) {
    filters.timestamp = {};
    if (startDate) filters.timestamp.gte = new Date(startDate);
    if (endDate) {
      // Inclusive end: go to end of that day
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filters.timestamp.lte = end;
    }
  }

  // Product filter (US-059)
  if (productId) {
    filters.productId = productId;
  }

  // Movement type filter (US-060)
  if (movementType) {
    filters.movementType = movementType;
  }

  // Client filter — find all productIds for the client, then filter by those (US-059)
  if (clientId) {
    const clientProducts = await productRepository.getProductsByField("clientId", clientId);
    const clientProductIds = clientProducts.map((p) => p.id);
    filters.productId = { in: clientProductIds };
  }

  return await inventoryLedgerRepository.getAllInventoryLedgers(filters);
};

// US-063: Get inventory ledger entries for a specific client (via their products)
const getInventoryLedgersByClientId = async (clientId) => {
  const clientProducts = await productRepository.getProductsByField("clientId", clientId);
  const clientProductIds = clientProducts.map((product) => product.id);

  if (clientProductIds.length === 0) return [];

  // Use the filter-based query — repository handles all includes
  return await inventoryLedgerRepository.getAllInventoryLedgers({
    productId: { in: clientProductIds },
  });
};

// US-054: Daily checkout summary — all CHECKOUT movements today, grouped by client
const getDailyCheckoutSummary = async (dateStr) => {
  const date = dateStr ? new Date(dateStr) : new Date();
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const checkouts = await inventoryLedgerRepository.getAllInventoryLedgers({
    movementType: "CHECKOUT",
    timestamp: { gte: startOfDay, lte: endOfDay },
  });

  // Group by client
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

// const updateInventoryLedger = async (id, updateData) => {
//   return await inventoryLedgerRepository.updateInventoryLedger(id, updateData);
// };

// const deleteInventoryLedger = async (id) => {
//   return await inventoryLedgerRepository.deleteInventoryLedger(id);
// };

// -------------------------------------------Helper Functions-----------------------------------------------

// Helper function to enrich inventory ledger entries with product details
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

// Helper function to enrich inventory ledger entries with location details
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

// Helper function to enrich inventory ledger entries with user details
const enrichLedgerEntriesWithUserDetails = async (ledgers) => {
  for (const ledger of ledgers) {
    const user = await userRepository.getUserByField("id", ledger.userId);
    ledger.userName = user ? user.name : "Unknown User";
  }
  return ledgers;
};

// Function to adjust stock levels based on inventory ledger entries (this would be called after creating a ledger entry)
const adjustStockLevels = async (ledgerEntry) => {
  let toStockLevel = null;
  let fromStockLevel = null;

  // Check if the stock exists for the product at the relevant location(s)
  if (ledgerEntry.toLocationId) {
    toStockLevel = await stockLevelLogic.getStockLevelByProductAndLocation(
      ledgerEntry.productId,
      ledgerEntry.toLocationId,
    );
  }
  if (ledgerEntry.fromLocationId) {
    fromStockLevel = await stockLevelLogic.getStockLevelByProductAndLocation(
      ledgerEntry.productId,
      ledgerEntry.fromLocationId,
    );
  }

  const increaseOrCreateToStock = async () => {
    // If stock exists at the toLocationId, increase it
    if (toStockLevel) {
      await stockLevelLogic.updateStockLevelByProductAndLocation(
        ledgerEntry.productId,
        ledgerEntry.toLocationId,
        {
          currentQuantity: toStockLevel.currentQuantity + ledgerEntry.quantity,
        },
      );
      return;
    }

    // If no stock exists at the toLocationId, create a new stock level entry
    await stockLevelLogic.createStockLevel({
      productId: ledgerEntry.productId,
      locationId: ledgerEntry.toLocationId,
      currentQuantity: ledgerEntry.quantity,
    });
  };

  const decreaseFromStock = async () => {
    // If stock exists at the fromLocationId, decrease it
    if (fromStockLevel) {
      if (fromStockLevel.currentQuantity < ledgerEntry.quantity) {
        throw new Error(
          `Insufficient stock at the from location to perform the ${ledgerEntry.movementType} movement.`,
        );
      }

      // For CHECKOUT
      if (ledgerEntry.movementType === "CHECKOUT") {
        if (fromStockLevel.reservedQuantity < ledgerEntry.quantity) {
          throw new Error(
            `Cannot perform the ${ledgerEntry.movementType} movement because the quantity exceeds the reserved stock at the from location.`,
          );
        }
        await stockLevelLogic.updateStockLevelByProductAndLocation(
          ledgerEntry.productId,
          ledgerEntry.fromLocationId,
          {
            currentQuantity:
              fromStockLevel.currentQuantity - ledgerEntry.quantity,
            reservedQuantity:
              fromStockLevel.reservedQuantity - ledgerEntry.quantity,
          },
        );
      }
      // For INTERNAL_MOVE
      else if (ledgerEntry.movementType === "INTERNAL_MOVE") {
        if (
          fromStockLevel.currentQuantity - fromStockLevel.reservedQuantity <
          ledgerEntry.quantity
        ) {
          throw new Error(
            `Cannot perform the ${ledgerEntry.movementType} movement because the quantity exceeds the available stock at the from location.`,
          );
        }
        await stockLevelLogic.updateStockLevelByProductAndLocation(
          ledgerEntry.productId,
          ledgerEntry.fromLocationId,
          {
            currentQuantity:
              fromStockLevel.currentQuantity - ledgerEntry.quantity,
          },
        );
      }
      //
    } else {
      throw new Error(`Stock not found at the specified from location.`);
    }
  };

  // - For CHECKIN
  if (ledgerEntry.movementType === "CHECKIN") {
    await increaseOrCreateToStock();
  }

  // For CHECKOUT
  if (ledgerEntry.movementType === "CHECKOUT") {
    // If stock exists at the fromLocationId, decrease it
    await decreaseFromStock();
  }

  // For INTERNAL_MOVE
  if (ledgerEntry.movementType === "INTERNAL_MOVE") {
    // Decrease stock at the fromLocationId
    await decreaseFromStock();

    // Increase stock at the toLocationId
    await increaseOrCreateToStock();
  }

  return true;
};

module.exports = {
  createInventoryLedger,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
  getInventoryLedgersByClientId,
  getLedgerWithFilters,
  getDailyCheckoutSummary,
  //   updateInventoryLedger,
  //   deleteInventoryLedger,
};
