const shipmentController = require('../controllers/shipment.controller');

const express = require('express');
const router = express.Router();

const { authorizeRoles } = require('../middlewares/authorize');

// Apply authorization middleware to all shipment routes
router.use(authorizeRoles('admin', 'employee')); // Only admin and employee can access shipment routes

router.post('/',  shipmentController.createShipment);
router.get('/field/:field/:value', shipmentController.getShipmentByField);
router.get('/client/:clientId', shipmentController.getShipmentsByClientId);
router.put('/:id', shipmentController.updateShipment);
router.delete('/:id', shipmentController.deleteShipment);
router.post('/:shipmentId/dispatch', shipmentController.dispatchShipment);

module.exports = router;