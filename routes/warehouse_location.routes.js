const warehouseLocationController = require("../controllers/warehouse_location_controller");
const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const router = express.Router();

router.get("/:field/:value", authorizeRoles('admin'), warehouseLocationController.getWarehouseLocationByField);
router.post("/", authorizeRoles('admin'), warehouseLocationController.createWarehouseLocation);
router.get("/", authorizeRoles('admin'), warehouseLocationController.getAllWarehouseLocations);
router.put("/:id", authorizeRoles('admin'), warehouseLocationController.updateWarehouseLocation);
router.delete("/:id", authorizeRoles('admin'), warehouseLocationController.deleteWarehouseLocation);

module.exports = router;