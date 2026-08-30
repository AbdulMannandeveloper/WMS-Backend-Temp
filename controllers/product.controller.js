const productLogic = require("../logic/product.logic");
const { pick } = require("../utils/pick");

const PRODUCT_FIELDS = [
  "clientId",
  "skuCode",
  "barcode",
  "productName",
  "colour",
  "size",
  "weight",
  "thresholdLimit",
  "isDeactivated",
];

const createProduct = async (req, res) => {
  try {
    const productData = pick(req.body, PRODUCT_FIELDS);
    const adminUserId = req.user.id;
    const product = await productLogic.addNewProduct(productData, adminUserId);
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
    const updateData = pick(req.body, PRODUCT_FIELDS);
    const adminUserId = req.user.id;
    const product = await productLogic.updateProduct(id, updateData, adminUserId);
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

const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUserId = req.user.id;
    const product = await productLogic.deleteProduct(id, adminUserId);
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.status(200).json({ message: "Product deleted successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Employee-accessible barcode lookup for the mobile check-in flow.
// Falls back to SKU code so manually typed SKUs also resolve.
/**
 * Resolves a scanned code.
 *
 * Returns every match rather than the first. A barcode is globally unique so it
 * yields one; a SKU is unique only within a client, so two clients stocking the
 * same SKU both come back and the operator picks. Returning products[0] here
 * used to mean a scan could silently attribute stock to the wrong client.
 */
const lookupProductByBarcode = async (req, res) => {
  try {
    const { value } = req.params;
    const { matches, matchedOn } = await productLogic.lookupByBarcodeOrSku(value);

    // The route is staff-only, so this is belt and braces rather than the
    // active guard — but it is the same scoping every other read in this
    // controller applies, and it means opening the route to clients later
    // cannot leak another client's catalogue by omission.
    const ownClientId = await resolveOwnClientId(req.user);
    const visible = ownClientId
      ? matches.filter((p) => p.clientId === ownClientId)
      : matches;

    if (visible.length === 0) {
      return res
        .status(404)
        .json({ error: "No product matches this barcode or SKU." });
    }

    res.status(200).json({ matches: visible, matchedOn });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

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
  deleteProduct,
  lookupProductByBarcode,
  getProductandStockLevelById
};
