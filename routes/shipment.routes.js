const shipmentController = require('../controllers/shipment.controller');
const shipmentServiceController = require('../controllers/shipment_service.controller');

const express = require('express');
const router = express.Router();

const { authorizeRoles } = require('../middlewares/authorize');

// Employees run the warehouse sequence — read, create, pick, mark ready,
// dispatch, and record the tracking number. Only an admin changes what a
// shipment *is* (client, courier, type) or removes it.
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

// The courier consignment number. Staff, not admin-only: the person handing the
// parcel over is the one holding the label. Allowed in every status but
// CANCELLED — a courier typically issues the number at the moment of dispatch,
// so freezing it with the rest of the shipment made it unrecordable.
router.put('/:id/tracking', staffOnly, shipmentController.setShipmentTracking);

// Billable services on a shipment. Staff may see what will be charged; only an
// admin changes it, and only while the shipment is still PENDING.
router.get('/:id/services', staffOnly, shipmentServiceController.listShipmentServices);
router.post('/:id/services', adminOnly, shipmentServiceController.addShipmentService);
router.delete('/:id/services/:mappingId', adminOnly, shipmentServiceController.removeShipmentService);

// Commercial / identity details, and removal
router.put('/:id', adminOnly, shipmentController.updateShipment);
router.delete('/:id', adminOnly, shipmentController.deleteShipment);

module.exports = router;
