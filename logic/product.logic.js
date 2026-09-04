const { prisma } = require("../lib/prisma");
const prodcutRepository = require("../repositories/product.repository");
const clientRepository = require("../repositories/client.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const auditLogLogic = require("./audit_log.logic");
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const { assertAllowedField } = require("../utils/pick");

const PRODUCT_QUERY_FIELDS = [
  "id",
  "skuCode",
  "barcode",
  "productName",
  "clientId",
  "colour",
  "size",
];

/**
 * What has to be true before a product row is written.
 *
 * Shared, because goods-in creates products inside a batch transaction and this
 * is the one place the rules live. Two copies would drift, and the copy that
 * drifted would be the one an employee could reach from the scanning bench.
 */
const assertProductIsValid = async (productData) => {
  if (!productData.productName || !productData.clientId || !productData.skuCode) {
    throw new Error(
      "Name, Client ID, and SKU Code are required to create a product.",
    );
  }

  // The client is never created in the same breath as a product, so this needs
  // no transaction to see it.
  const client = await clientRepository.getClientById(productData.clientId);
  if (!client) {
    throw new Error("Client not found.");
  }

  if (productData.size && productData.size <= 0) {
    throw new Error("Size must be a positive number.");
  }

  if (productData.weight && productData.weight <= 0) {
    throw new Error("Weight must be a positive number.");
  }

  if (!productData.isDeactivated) {
    productData.isDeactivated = false; // Default to active if not provided
  }

  return productData;
};

/**
 * Creates a product, optionally placing its opening stock in the same transaction.
 *
 * @param {object} productData
 * @param {string} actorUserId - who performed this (admin or employee)
 * @param {{ locationId: string, quantity: number, notes?: string }} [initialStock]
 *   When supplied, a CHECKIN ledger entry is recorded so the stock level, the
 *   arrived-today counter and the double-entry trail all stay consistent. Product
 *   and stock are committed together or not at all.
 */
const addNewProduct = async (productData, actorUserId, initialStock) => {
  await assertProductIsValid(productData);

  if (initialStock) {
    if (!initialStock.locationId) {
      throw new Error("A destination location is required to add opening stock.");
    }
    if (!Number.isInteger(Number(initialStock.quantity)) || Number(initialStock.quantity) <= 0) {
      throw new Error("Opening stock quantity must be a positive whole number.");
    }
    if (!actorUserId) {
      throw new Error("An authenticated user is required to add opening stock.");
    }
  }

  const newProduct = initialStock
    ? await prisma.$transaction(
        async (tx) => {
          const created = await prodcutRepository.createProduct(productData, tx);
          await inventoryLedgerLogic.createInventoryLedger(
            {
              productId: created.id,
              userId: actorUserId,
              movementType: "CHECKIN",
              quantity: Number(initialStock.quantity),
              toLocationId: initialStock.locationId,
              notes: initialStock.notes || "Opening stock",
            },
            { tx },
          );
          return created;
        },
        { maxWait: 10_000, timeout: 30_000 },
      )
    : await prodcutRepository.createProduct(productData);

  if (actorUserId) {
    await auditLogLogic.createAuditLog(actorUserId, "CREATE_PRODUCT", {
      productId: newProduct.id,
      skuCode: newProduct.skuCode,
      productName: newProduct.productName,
      ...(initialStock
        ? {
            openingQuantity: Number(initialStock.quantity),
            openingLocationId: initialStock.locationId,
          }
        : {}),
    }).catch(err => console.error("Audit log error:", err.message));
  }
  return newProduct;
};

const getAllProducts = async () => {
  return await prodcutRepository.getAllProducts();
};

const getProductById = async (id) => {
  return await prodcutRepository.getProductByField("id", id);
};

const getProductByName = async (name) => {
  return await prodcutRepository.getProductsByField("productName", name);
};

const getProductByBarcode = async (barcode) => {
  return await prodcutRepository.getProductsByField("barcode", barcode);
};

const getProductBySkuCode = async (skuCode) => {
  return await prodcutRepository.getProductsByField("skuCode", skuCode);
};

/**
 * Resolves a scanned code to the products it could mean.
 *
 * Barcode first: that column is globally unique, so a hit is unambiguous and is
 * returned alone. Only when it misses do we fall back to SKU — and skuCode is
 * unique *per client*, not globally, so two clients can legitimately stock the
 * same SKU.
 *
 * That is why this returns every match rather than the first one. Silently
 * picking one would check stock in against the wrong client's product, which
 * lands in their inventory and eventually on their invoice, and nobody notices
 * until it is disputed.
 */
const lookupByBarcodeOrSku = async (value) => {
  const code = String(value ?? "").trim();
  if (!code) {
    return { matches: [], matchedOn: null };
  }

  const byBarcode = await prodcutRepository.getProductsByFieldWithStock(
    "barcode",
    code,
  );
  if (byBarcode.length > 0) {
    return { matches: byBarcode, matchedOn: "barcode" };
  }

  const bySku = await prodcutRepository.getProductsByFieldWithStock(
    "skuCode",
    code,
  );
  return {
    matches: bySku,
    matchedOn: bySku.length > 0 ? "skuCode" : null,
  };
};

const getProductByClientId = async (clientId) => {
  return await prodcutRepository.getProductsByField("clientId", clientId);
};

const getProductByField = async (field, value) => {
  // If querying by name, translate it to the database schema field 'productName'
  const queryField = field === "name" ? "productName" : field;
  assertAllowedField(queryField, PRODUCT_QUERY_FIELDS);
  return await prodcutRepository.getProductsByField(queryField, value);
};

const updateProduct = async (id, updateData, actorUserId) => {
  if (updateData.size && updateData.size <= 0) {
    throw new Error("Size must be a positive number.");
  }

  if (updateData.weight && updateData.weight <= 0) {
    throw new Error("Weight must be a positive number.");
  }

  // Binding a scanned barcode to a product is a normal action from the scanner,
  // and colliding with one already in use is a normal mistake. Name the other
  // product rather than letting a raw unique-constraint error reach the UI.
  if (updateData.barcode) {
    const existing = await prodcutRepository.getProductsByField(
      "barcode",
      updateData.barcode,
    );
    const other = existing.find((p) => p.id !== id);
    if (other) {
      throw new Error(
        `That barcode is already assigned to ${other.skuCode}${
          other.productName ? ` (${other.productName})` : ""
        }. Scan it to open that product, or clear it there first.`,
      );
    }
  }

  const updatedProduct = await prodcutRepository.updateProduct(id, updateData);
  if (actorUserId) {
    await auditLogLogic.createAuditLog(actorUserId, "EDIT_PRODUCT", {
      productId: id,
      skuCode: updatedProduct.skuCode,
      changes: updateData,
    }).catch(err => console.error("Audit log error:", err.message));
  }
  return updatedProduct;
};

/**
 * Toggles a product between active and deactivated.
 * Deactivation is the reversible alternative to deleteProduct, which is a hard delete.
 */
const deactivateProduct = async (id, actorUserId) => {
  const product = await prodcutRepository.getProductById(id);
  if (!product) {
    return null;
  }

  const updatedProduct = await prodcutRepository.updateProduct(id, {
    isDeactivated: !product.isDeactivated,
  });

  if (actorUserId) {
    await auditLogLogic.createAuditLog(
      actorUserId,
      updatedProduct.isDeactivated ? "DEACTIVATE_PRODUCT" : "REACTIVATE_PRODUCT",
      {
        productId: id,
        skuCode: updatedProduct.skuCode,
        productName: updatedProduct.productName,
      },
    ).catch(err => console.error("Audit log error:", err.message));
  }
  return updatedProduct;
};

const deleteProduct = async (id, actorUserId) => {
  const deletedProduct = await prodcutRepository.deleteProduct(id);
  if (actorUserId) {
    await auditLogLogic.createAuditLog(actorUserId, "DELETE_PRODUCT", {
      productId: id,
      skuCode: deletedProduct?.skuCode,
      productName: deletedProduct?.productName,
    }).catch(err => console.error("Audit log error:", err.message));
  }
  return deletedProduct;
};



const RECENT_MOVEMENT_LIMIT = 20;

/**
 * Everything the product detail view needs, in one round trip: the product, its
 * stock broken down by location, the total on hand, and its recent movements.
 *
 * @returns {null} when no product matches, so the caller can answer 404
 */
const getProductandStockLevelById = async (id) => {
  const product = await prodcutRepository.getProductByField("id", id);
  if (!product) {
    return null;
  }

  const stockLevels = await stockLevelRepository.getStockLevelByField("productId", id);
  const totalQuantity = stockLevels.reduce(
    (sum, level) => sum + (level.currentQuantity || 0),
    0,
  );

  const recentMovements = await inventoryLedgerLogic
    .getLedgerWithFilters({ productId: id }, { skip: 0, take: RECENT_MOVEMENT_LIMIT })
    .catch(() => ({ items: [] }));

  return {
    product,
    stockLevels,
    totalQuantity,
    recentMovements: recentMovements.items || recentMovements,
  };
};

module.exports = {
  assertProductIsValid,
  addNewProduct,
  getAllProducts,
  getProductById,
  getProductByName,
  getProductByBarcode,
  getProductBySkuCode,
  lookupByBarcodeOrSku,
  getProductByClientId,
  getProductByField,
  updateProduct,
  deactivateProduct,
  deleteProduct,
  getProductandStockLevelById
};
