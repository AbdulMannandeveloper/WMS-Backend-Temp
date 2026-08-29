const shimpentItemController = require("../controllers/shipment_item.controller");

const express = require("express");
const router = express.Router();

const { authorizeRoles } = require("../middlewares/authorize");

// Picking is warehouse work: admin and employee both do it.
const staffOnly = authorizeRoles("admin", "employee");
const adminOnly = authorizeRoles("admin");

// Pick / unpick. Separate endpoints rather than a status field on the generic
// update, so the transition can be guarded against the parent shipment's state.
router.put("/:id/pick", staffOnly, shimpentItemController.pickShipmentItem);
router.put("/:id/unpick", staffOnly, shimpentItemController.unpickShipmentItem);

// Quantity, source location and tracking id. Admin-only, matching the shipment
// itself — changing what is going out is a commercial decision.
router.put("/:id", adminOnly, shimpentItemController.updateShipmentItem);

// -----------------------------NOT EXPOSED FOR NOW-----------------------------
// router.post('/', shimpentItemController.createShipmentItem);
// router.get('/field/:field/:value', shimpentItemController.getShipmentItemsByField);
// router.delete('/:id', shimpentItemController.deleteShipmentItem);

module.exports = router;
