const shimpentItemController = require("../controllers/shipment_item.controller");

const express = require("express");
const router = express.Router();

const { authorizeRoles } = require("../middlewares/authorize");

// Apply authorization middleware to all shipment item routes
router.use(authorizeRoles("admin", "employee")); // Only admin and employee can access shipment item routes

// Only update route is open for now, as shipment items are created through the shipment creation process
router.put("/:id", shimpentItemController.updateShipmentItem);


// -----------------------------NOT EXPOSED FOR NOW-----------------------------
// router.post('/', shimpentItemController.createShipmentItem);
// router.get('/field/:field/:value', shimpentItemController.getShipmentItemsByField);
// router.delete('/:id', shimpentItemController.deleteShipmentItem);

module.exports = router;
