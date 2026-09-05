const warehouseLocationController = require("../controllers/warehouse_location_controller");
const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const router = express.Router();

// Warehouse layout is the employees' own working environment: they are the ones
// who discover a shelf is full, need a new bin at the end of an aisle, or find a
// location labelled wrongly. Making them fetch an admin mid-shift to record what
// they are already looking at is how the map drifts out of step with the
// building. Full access, same as an admin — except deleting one, which removes
// a place stock could be standing and is not something to do mid-shift.

// US-029: Named routes BEFORE wildcard /:field/:value to prevent routing conflicts
// Returns all locations as a nested parent-child tree
router.get("/tree", authorizeRoles('admin', 'employee'), warehouseLocationController.getWarehouseLocationTree);

router.get("/:field/:value", authorizeRoles('admin', 'employee'), warehouseLocationController.getWarehouseLocationByField);
router.post("/", authorizeRoles('admin', 'employee'), warehouseLocationController.createWarehouseLocation);
router.get("/", authorizeRoles('admin', 'employee'), warehouseLocationController.getAllWarehouseLocations);
router.put("/:id", authorizeRoles('admin', 'employee'), warehouseLocationController.updateWarehouseLocation);
router.delete("/:id", authorizeRoles('admin'), warehouseLocationController.deleteWarehouseLocation);

module.exports = router;
