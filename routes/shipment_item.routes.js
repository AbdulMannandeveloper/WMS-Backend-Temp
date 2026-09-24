const shimpentItemController = require("../controllers/shipment_item.controller");

const express = require("express");
const router = express.Router();

const { authorizeRoles } = require("../middlewares/authorize");
const { requirePermission } = require("../middlewares/requirePermission");

// Picking is warehouse work, and every part of it is governed by the shipments
// permission — an item only exists inside a shipment, so a separate module for
// it would be a permission nobody could reason about.
const staffOnly = authorizeRoles("admin", "employee");
const staffWith = (action) => [staffOnly, requirePermission("shipments", action)];

// Pick / unpick. Separate endpoints rather than a status field on the generic
// update, so the transition can be guarded against the parent shipment's state.
router.put("/:id/pick", staffWith("update"), shimpentItemController.pickShipmentItem);
router.put("/:id/unpick", staffWith("update"), shimpentItemController.unpickShipmentItem);

// Quantity, source location and tracking id — what is going out on this line.
// Granted with shipments:update, and guarded against the parent shipment's
// state underneath: the line is only editable while it can still be changed.
router.put("/:id", staffWith("update"), shimpentItemController.updateShipmentItem);

// Returning goods that went out and came back. It puts stock on the shelf and
// deliberately does not touch the invoice: the dispatch happened and was
// charged for, and what follows is a commercial conversation elsewhere. Mapped
// to update rather than delete — the line survives, its quantity changes.
router.post("/:id/return", staffWith("update"), shimpentItemController.returnShipmentItem);

// -----------------------------NOT EXPOSED FOR NOW-----------------------------
// router.post('/', shimpentItemController.createShipmentItem);
// router.get('/field/:field/:value', shimpentItemController.getShipmentItemsByField);
// router.delete('/:id', shimpentItemController.deleteShipmentItem);

module.exports = router;
