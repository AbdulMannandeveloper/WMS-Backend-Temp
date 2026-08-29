const shipmentController = require('../controllers/shipment.controller');

const express = require('express');
const router = express.Router();

const { authorizeRoles } = require('../middlewares/authorize');

// Employees run the warehouse sequence — read, create, pick, mark ready,
// dispatch. Only an admin changes what a shipment *is* (client, courier, type,
// tracking id) or removes it.
const staffOnly = authorizeRoles('admin', 'employee');
const adminOnly = authorizeRoles('admin');

// Reads
router.get('/', staffOnly, shipmentController.getAllShipments);
router.get('/field/:field/:value', staffOnly, shipmentController.getShipmentByField);
router.get('/client/:clientId', staffOnly, shipmentController.getShipmentsByClientId);

router.post('/', staffOnly, shipmentController.createShipment);

// Lifecycle transitions. Each one guards the move against the state machine in
// logic/shipment.logic.js — status is not settable through PUT.
router.post('/:id/ready', staffOnly, shipmentController.markShipmentReady);
router.post('/:shipmentId/dispatch', staffOnly, shipmentController.dispatchShipment);
router.post('/:id/cancel', adminOnly, shipmentController.cancelShipment);
router.post('/:id/reopen', adminOnly, shipmentController.reopenShipment);

// Commercial / identity details, and removal
router.put('/:id', adminOnly, shipmentController.updateShipment);
router.delete('/:id', adminOnly, shipmentController.deleteShipment);

module.exports = router;
