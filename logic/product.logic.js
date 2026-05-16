const prodcutRepository = require("../repositories/product.repository");
const clientRepository = require("../repositories/client.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");

const addNewProduct = async (productData) => {
  if (!productData.name || !productData.clientId || !productData.skuCode) {
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

  return await prodcutRepository.createProduct(productData);
};

const getAllProducts = async () => {
  return await prodcutRepository.getAllProducts();
};

const getProductById = async (id) => {
  return await prodcutRepository.getProductByField("id", id);
};

const getProductByName = async (name) => {
  return await prodcutRepository.getProductsByField("name", name);
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

const updateProduct = async (id, updateData) => {
  if (updateData.size && updateData.size <= 0) {
    throw new Error("Size must be a positive number.");
  }

  if (updateData.weight && updateData.weight <= 0) {
    throw new Error("Weight must be a positive number.");
  }

  return await prodcutRepository.updateProduct(id, updateData);
};

// const deleteProduct = async (id) => {
//   return await prodcutRepository.deleteProduct(id);
// };



const getProductandStockLevelById = async (id) => {
  const product = await prodcutRepository.getProductByField("id", id);
  if (!product) {
    throw new Error("Product not found.");
  }
  const stockLevels = await stockLevelRepository.getStockLevelByProductId(id);

  return {
    product,
    stockLevels,
  };
};

module.exports = {
  addNewProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  // deleteProduct,
  getProductandStockLevelById
};
