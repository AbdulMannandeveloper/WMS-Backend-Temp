const warehhouseLocationLogic = require("../logic/warehouse_location.logic");
const { paginatedResponse } = require("../utils/pagination");
const { buildListQuery } = require("../utils/queryFilters");
const { listError } = require("../utils/listResponse");

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
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      warehhouseLocationLogic.WAREHOUSE_LOCATION_LIST_SPEC,
    );

    const result = await warehhouseLocationLogic.getAllWarehouseLocations(where, {
      orderBy,
      pagination,
    });

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (error) {
    return listError(res, error, "getAllWarehouseLocations");
  }
};

/** Counts for the whole filtered set, broken down by location class. */
const getWarehouseLocationSummary = async (req, res) => {
  try {
    const { where } = buildListQuery(
      req.query,
      warehhouseLocationLogic.WAREHOUSE_LOCATION_LIST_SPEC,
    );
    return res
      .status(200)
      .json(await warehhouseLocationLogic.summariseWarehouseLocations(where));
  } catch (error) {
    return listError(res, error, "getWarehouseLocationSummary");
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

// US-029: Return all warehouse locations as a nested tree structure
const getWarehouseLocationTree = async (req, res) => {
  try {
    const tree = await warehhouseLocationLogic.getWarehouseLocationTree();
    res.status(200).json(tree);
  } catch (error) {
    console.error("Error building warehouse location tree:", error);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
};

module.exports = {
  getWarehouseLocationSummary,
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  getWarehouseLocationTree,
  updateWarehouseLocation,
  deleteWarehouseLocation,
};