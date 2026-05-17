const stockLevelLogic = require("../logic/stock_level.logic");

const createStockLevel = async (req, res) => {
  try {
    const stockLevelData = req.body;
    const stockLevel = await stockLevelLogic.createStockLevel(stockLevelData);
    res.status(201).json(stockLevel);
  } catch (error) {
    // Handle validation errors and other issues gracefully
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (
      error.message.includes("required") ||
      error.message.includes("negative")
    ) {
      return res.status(400).json({ error: error.message });
    }

    // For unexpected errors, return a generic server error response
    res.status(500).json({ error: "An unexpected error occurred." });
  }
};

const getAllStockLevels = async (req, res) => {
  try {
    const stockLevels = await stockLevelLogic.getAllStockLevels();
    res.status(200).json(stockLevels);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getStockLevelByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const stockLevel = await stockLevelLogic.getStockLevelByField(field, value);
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getStockLevelByProductId = async (req, res) => {
  try {
    const { productId } = req.params;
    const stockLevel = await stockLevelLogic.getStockLevelByField(
      "productId",
      productId,
    );
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getStockLevelByLocationId = async (req, res) => {
  try {
    const { locationId } = req.params;
    const stockLevel = await stockLevelLogic.getStockLevelByField(
      "locationId",
      locationId,
    );
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateStockLevel = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const stockLevel = await stockLevelLogic.updateStockLevel(id, updateData);
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
};

const updateStockLevelByProductAndLocation = async (req, res) => {
  try {
    const { productId, locationId } = req.params;
    const updateData = req.body;
    const stockLevel =
      await stockLevelLogic.updateStockLevelByProductAndLocation(
        productId,
        locationId,
        updateData,
      );
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
};

const deleteStockLevel = async (req, res) => {
  try {
    const { id } = req.params;
    const stockLevel = await stockLevelLogic.deleteStockLevel(id);
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res
      .status(200)
      .json({ message: "Stock level deleted successfully.", stockLevel });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createStockLevel,
  getAllStockLevels,
  getStockLevelByField,
  getStockLevelByProductId,
  getStockLevelByLocationId,
  updateStockLevel,
  updateStockLevelByProductAndLocation,
  deleteStockLevel,
};
