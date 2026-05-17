const warehouseLocationController = require("../controllers/warehouse_location_controller");
const express = require("express");
const router = express.Router();

router.post("/", warehouseLocationController.createWarehouseLocation);
router.get("/", warehouseLocationController.getAllWarehouseLocations);
router.get("/:field/:value", warehouseLocationController.getWarehouseLocationByField);
router.put("/:id", warehouseLocationController.updateWarehouseLocation);
router.delete("/:id", warehouseLocationController.deleteWarehouseLocation);

module.exports = router;