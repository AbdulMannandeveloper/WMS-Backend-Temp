const prodcutRepository = require("../repositories/product.repository");
const clientRepository = require("../repositories/client.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const auditLogLogic = require("./audit_log.logic");
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

const addNewProduct = async (productData, adminUserId) => {
  if (!productData.productName || !productData.clientId || !productData.skuCode) {
    throw new Error(
      "Name, Client ID, and SKU Code are required to create a product.",
    );
  }

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

  const newProduct = await prodcutRepository.createProduct(productData);
  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, "CREATE_PRODUCT", {
      productId: newProduct.id,
      skuCode: newProduct.skuCode,
      productName: newProduct.productName,
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

const updateProduct = async (id, updateData, adminUserId) => {
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
  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, "EDIT_PRODUCT", {
      productId: id,
      skuCode: updatedProduct.skuCode,
      changes: updateData,
    }).catch(err => console.error("Audit log error:", err.message));
  }
  return updatedProduct;
};

const deleteProduct = async (id, adminUserId) => {
  const deletedProduct = await prodcutRepository.deleteProduct(id);
  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, "DELETE_PRODUCT", {
      productId: id,
      skuCode: deletedProduct?.skuCode,
      productName: deletedProduct?.productName,
    }).catch(err => console.error("Audit log error:", err.message));
  }
  return deletedProduct;
};



const getProductandStockLevelById = async (id) => {
  const product = await prodcutRepository.getProductByField("id", id);
  if (!product) {
    throw new Error("Product not found.");
  }
  const stockLevels = await stockLevelRepository.getStockLevelByField("productId", id);

  return {
    product,
    stockLevels,
  };
};

module.exports = {
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
  deleteProduct,
  getProductandStockLevelById
};
