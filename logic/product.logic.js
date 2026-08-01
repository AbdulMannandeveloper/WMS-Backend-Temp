const prodcutRepository = require("../repositories/product.repository");
const clientRepository = require("../repositories/client.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const auditLogLogic = require("./audit_log.logic");

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

const getProductByClientId = async (clientId) => {
  return await prodcutRepository.getProductsByField("clientId", clientId);
};

const getProductByField = async (field, value) => {
  // If querying by name, translate it to the database schema field 'productName'
  const queryField = field === "name" ? "productName" : field;
  return await prodcutRepository.getProductsByField(queryField, value);
};

const updateProduct = async (id, updateData, adminUserId) => {
  if (updateData.size && updateData.size <= 0) {
    throw new Error("Size must be a positive number.");
  }

  if (updateData.weight && updateData.weight <= 0) {
    throw new Error("Weight must be a positive number.");
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
  getProductByClientId,
  getProductByField,
  updateProduct,
  deleteProduct,
  getProductandStockLevelById
};
