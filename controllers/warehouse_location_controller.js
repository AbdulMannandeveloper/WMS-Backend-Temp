const warehhouseLocationLogic = require("../logic/warehouse_location.logic");

const createWarehouseLocation = async (req, res) => {
  try {
    const locationData = req.body;
    const newLocation =
      await warehhouseLocationLogic.createWarehouseLocation(locationData);
    res.status(201).json(newLocation);
  } catch (error) {
    // Handle validation errors and other exceptions
    if (
      error.message.includes("required") ||
      error.message.includes("Invalid") ||
      error.message.includes("not exist") ||
      error.message.includes("already exists")
    ) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unexpected error occurred" });
    }
  }
};

const getAllWarehouseLocations = async (req, res) => {
  try {
    const locations = await warehhouseLocationLogic.getAllWarehouseLocations();
    res.status(200).json(locations);
  } catch (error) {
    console.error("Error fetching warehouse locations:", error);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
};

const getWarehouseLocationByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const locations = await warehhouseLocationLogic.getWarehouseLocationByField(
      field,
      value,
    );
    res.status(200).json(locations);
  } catch (error) {
    console.error("Error fetching warehouse location by field:", error);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
};

const updateWarehouseLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const updatedLocation =
      await warehhouseLocationLogic.updateWarehouseLocation(id, updateData);
    res.status(200).json(updatedLocation);
  } catch (error) {
    console.error("Error updating warehouse location:", error);
    if (
      error.message.includes("Invalid") ||
      error.message.includes("not exist") ||
      error.message.includes("already exists")
    ) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unexpected error occurred" });
    }
  }
};

const deleteWarehouseLocation = async (req, res) => {
  try {
    const { id } = req.params;
    await warehhouseLocationLogic.deleteWarehouseLocation(id);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting warehouse location:", error);

    // Handle database constraint errors (e.g., foreign key violations)
    if (error.code === "P2003") {
      res.status(400).json({
        error:
          "Cannot delete this location because it is referenced by other records. Please remove those references first.",
      });
    } else {
      res.status(500).json({ error: "An unexpected error occurred" });
    }
  }
};

module.exports = {
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  updateWarehouseLocation,
  deleteWarehouseLocation,
};