const warehouseLocationClassLogic = require("../logic/warehouse_location.logic");

const createWarehouseLocationClass = async (req, res) => {
  try {
    const createdClass =
      await warehouseLocationClassLogic.createWarehouseLocationClass(req.body);
    res.status(201).json(createdClass);
  } catch (error) {
    if (
      error.message.includes("required") ||
      error.message.includes("Invalid") ||
      error.message.includes("exist") ||
      error.message.includes("already exists") ||
      error.message.includes("cycle")
    ) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unexpected error occurred" });
    }
  }
};

const getAllWarehouseLocationClasses = async (req, res) => {
  try {
    const classes = await warehouseLocationClassLogic.getAllWarehouseLocationClasses();
    res.status(200).json(classes);
  } catch (error) {
    console.error("Error fetching warehouse location classes:", error);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
};

const getWarehouseLocationClassByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const classes = await warehouseLocationClassLogic.getWarehouseLocationClassByField(
      field,
      value,
    );
    res.status(200).json(classes);
  } catch (error) {
    console.error("Error fetching warehouse location class by field:", error);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
};

const updateWarehouseLocationClass = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedClass = await warehouseLocationClassLogic.updateWarehouseLocationClass(
      id,
      req.body,
    );
    res.status(200).json(updatedClass);
  } catch (error) {
    if (
      error.message.includes("required") ||
      error.message.includes("Invalid") ||
      error.message.includes("exist") ||
      error.message.includes("already exists") ||
      error.message.includes("cycle")
    ) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unexpected error occurred" });
    }
  }
};

const deleteWarehouseLocationClass = async (req, res) => {
  try {
    const { id } = req.params;
    await warehouseLocationClassLogic.deleteWarehouseLocationClass(id);
    res.status(204).send();
  } catch (error) {
    if (error.message.toLowerCase().includes("cannot delete")) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unexpected error occurred" });
    }
  }
};

module.exports = {
  createWarehouseLocationClass,
  getAllWarehouseLocationClasses,
  getWarehouseLocationClassByField,
  updateWarehouseLocationClass,
  deleteWarehouseLocationClass,
};