const productLogic = require("../logic/product.logic");

const createProduct = async (req, res) => {
  try {
    const productData = req.body;
    const product = await productLogic.addNewProduct(productData);
    res.status(201).json(product);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllProducts = async (req, res) => {
  try {
    const products = await productLogic.getAllProducts();
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await productLogic.getProductById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.status(200).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getProductByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const products = await productLogic.getProductByField(field, value);
    if (!products || products.length === 0) {
      return res.status(404).json({ error: "No products found." });
    }
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const product = await productLogic.updateProduct(id, updateData);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.status(200).json(product);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deactivateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await productLogic.deactivateProduct(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    res
      .status(200)
      .json({ message: "Product deactivated successfully.", product });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// const deleteProduct = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const product = await productLogic.deleteProduct(id);
//         if (!product) {
//             return res.status(404).json({ error: "Product not found." });
//         }
//         res.status(200).json({ message: "Product deleted successfully." });
//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// };

const getProductandStockLevelById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await productLogic.getProductandStockLevelById(id);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createProduct,
  getAllProducts,
  getProductById,
  getProductByField,
  updateProduct,
  deactivateProduct,
    // deleteProduct,
  getProductandStockLevelById
};
