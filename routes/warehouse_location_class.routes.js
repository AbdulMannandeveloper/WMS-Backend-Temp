const warehouseLocationClassController = require("../controllers/warehouse_location_class.controller");
const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const router = express.Router();

router.get(
  "/:field/:value",
  authorizeRoles("admin"),
  warehouseLocationClassController.getWarehouseLocationClassByField,
);
router.post(
  "/",
  authorizeRoles("admin"),
  warehouseLocationClassController.createWarehouseLocationClass,
);
router.get(
  "/",
  authorizeRoles("admin"),
  warehouseLocationClassController.getAllWarehouseLocationClasses,
);
router.put(
  "/:id",
  authorizeRoles("admin"),
  warehouseLocationClassController.updateWarehouseLocationClass,
);
router.delete(
  "/:id",
  authorizeRoles("admin"),
  warehouseLocationClassController.deleteWarehouseLocationClass,
);

module.exports = router;