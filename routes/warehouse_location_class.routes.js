const warehouseLocationClassController = require("../controllers/warehouse_location_class.controller");
const express = require("express");
const { authorizeRoles } = require("../middlewares/authorize");
const router = express.Router();

// Warehouse layout is the employees' own working environment: they are the ones
// who discover a shelf is full, need a new bin at the end of an aisle, or find a
// location labelled wrongly. Making them fetch an admin mid-shift to record what
// they are already looking at is how the map drifts out of step with the
// building. Full access, same as an admin — except deleting a class, which
// every location of that kind depends on.

router.get(
  "/:field/:value",
  authorizeRoles("admin", "employee"),
  warehouseLocationClassController.getWarehouseLocationClassByField,
);
router.post(
  "/",
  authorizeRoles("admin", "employee"),
  warehouseLocationClassController.createWarehouseLocationClass,
);
router.get(
  "/",
  authorizeRoles("admin", "employee"),
  warehouseLocationClassController.getAllWarehouseLocationClasses,
);
router.put(
  "/:id",
  authorizeRoles("admin", "employee"),
  warehouseLocationClassController.updateWarehouseLocationClass,
);
router.delete(
  "/:id",
  authorizeRoles("admin"),
  warehouseLocationClassController.deleteWarehouseLocationClass,
);

module.exports = router;