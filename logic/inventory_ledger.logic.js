const inventoryLedgerRepository = require("../repositories/inventory_ledger.repository");
const productRepository = require("../repositories/product.repository");
const locationRepository = require("../repositories/location.repository");

const stockLevelLogic = require("./stock_level.logic");

const createInventoryLedger = async (newData) => {
  if (
    !newData.productId ||
    !newData.userId ||
    !newData.quantity ||
    !newData.movementType ||
    !newData.quantity
  ) {
    throw new Error(
      "Product ID, user ID, quantity, movement type, and quantity are required to create an inventory ledger entry.",
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
  if (newData.referenceId) {
    // Depending on the movement type, the reference ID could point to different entities (e.g., purchase order for checkin, sales order for checkout)
    // You would need to implement logic to check the reference ID against the appropriate entity based on the movement type. For example:
    if (newData.movementType === "CHECKIN") {
      // Check if the reference ID corresponds to a valid purchase order
    } else if (newData.movementType === "CHECKOUT") {
      // Check if the reference ID corresponds to a valid sales order
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

  const inventoryLedgerEntry = await inventoryLedgerRepository(newData);

  // Adjust stock levels based on the new ledger entry
  const stockAdjusted = await adjustStockLevels(inventoryLedgerEntry);

  if (!stockAdjusted) {
    await inventoryLedgerRepository.deleteInventoryLedger(inventoryLedgerEntry.id); // Rollback the ledger entry if stock adjustment fails
    throw new Error("Failed to adjust stock levels based on the inventory ledger entry.");
  }
  
  return inventoryLedgerEntry;
};

const getAllInventoryLedgers = async () => {
  return await inventoryLedgerRepository.getAllInventoryLedgers();
};

const getInventoryLedgerByField = async (field, value) => {
  return await inventoryLedgerRepository.getInventoryLedgerByField(
    field,
    value,
  );
};

// const updateInventoryLedger = async (id, updateData) => {
//   return await inventoryLedgerRepository.updateInventoryLedger(id, updateData);
// };

// const deleteInventoryLedger = async (id) => {
//   return await inventoryLedgerRepository.deleteInventoryLedger(id);
// };


// -------------------------------------------Helper Functions-----------------------------------------------
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
    if (toStockLevel) {
      await stockLevelLogic.updateStockLevelByProductAndLocation(
        ledgerEntry.productId,
        ledgerEntry.toLocationId,
        { currentQuantity: toStockLevel.currentQuantity + ledgerEntry.quantity }
      );
      return;
    }

    await stockLevelLogic.createStockLevel({
      productId: ledgerEntry.productId,
      locationId: ledgerEntry.toLocationId,
      currentQuantity: ledgerEntry.quantity,
    });
  };

  const decreaseFromStock = async () => {
    if (fromStockLevel) {
      await stockLevelLogic.updateStockLevelByProductAndLocation(
        ledgerEntry.productId,
        ledgerEntry.fromLocationId,
        { currentQuantity: fromStockLevel.currentQuantity - ledgerEntry.quantity }
      );
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
  //   updateInventoryLedger,
  //   deleteInventoryLedger,
};
