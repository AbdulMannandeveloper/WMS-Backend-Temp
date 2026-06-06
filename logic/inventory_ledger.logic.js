const inventoryLedgerRepository = require("../repositories/inventory_ledger.repository");
const productRepository = require("../repositories/product.repository");
const locationRepository = require("../repositories/warehouse_location.repository");
const userRepository = require("../repositories/user.repository");

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
  const ledgers = await inventoryLedgerRepository.getAllInventoryLedgers();

  // Enrich ledger entries with product, location, and user details
  await enrichLedgerEntriesWithProductDetails(ledgers);
  await enrichLedgerEntriesWithLocationDetails(ledgers);
  await enrichLedgerEntriesWithUserDetails(ledgers);
};

const getInventoryLedgerByField = async (field, value) => {
  const ledgers = await inventoryLedgerRepository.getInventoryLedgerByField(
    field,
    value,
  );

  // Enrich ledger entries with product, location, and user details
  await enrichLedgerEntriesWithProductDetails(ledgers);
  await enrichLedgerEntriesWithLocationDetails(ledgers);
  await enrichLedgerEntriesWithUserDetails(ledgers);

  // Enrich ledger entries with client details (e.g., name - via product)
  for (const ledger of ledgers) {
    const product = await productRepository.getProductByField(
      "id",
      ledger.productId,
    );
    const client = product
      ? await clientRepository.getClientByField("id", product.clientId)
      : null;
    ledger.clientId = product ? product.clientId : null;
    ledger.clientName = client ? client.name : "Unknown Client";
  }

  return ledgers;
};

// Function to get inventory ledger entries for a specific client (clientId is referenced in the product table)
const getInventoryLedgersByClientId = async (clientId) => {
  // Get all products for the client
  const clientProducts = await productRepository.getProductsByField(
    "clientId",
    clientId,
  );
  const clientProductIds = clientProducts.map((product) => product.id);

  // Get all inventory ledger entries for those products
  const inventoryLedgers =
    await inventoryLedgerRepository.getInventoryLedgerByField("productId", {
      in: clientProductIds,
    });

  // Enrich ledger entries with product details
  for (const ledger of inventoryLedgers) {
    const product = clientProducts.find((p) => p.id === ledger.productId);
    ledger.productName = product ? product.name : "Unknown Product";
  }

  // Enrich ledger entries with location details
  for (const ledger of inventoryLedgers) {
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

  // Enrich ledger entries with user details
  for (const ledger of inventoryLedgers) {
    const user = await userRepository.getUserByField("id", ledger.userId);
    ledger.userName = user ? user.name : "Unknown User";
  }

  return inventoryLedgers;
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
  //   updateInventoryLedger,
  //   deleteInventoryLedger,
};
