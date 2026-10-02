const shipmentController = require('../controllers/shipment.controller');
const shipmentServiceController = require('../controllers/shipment_service.controller');

const express = require('express');
const router = express.Router();

const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');

// Employees run the warehouse sequence — read, create, pick, mark ready,
// dispatch, and record the tracking number — but each part of it is granted
// individually now rather than coming with the role.
const staffOnly = authorizeRoles('admin', 'employee');
const staffWith = (action) => [staffOnly, requirePermission('shipments', action)];

// Two mappings here are judgement calls rather than the HTTP verb.
//
// Cancel is a delete. It is the soft-delete of a shipment: the row survives
// because the audit trail and the invoice line both reference it, but what the
// operator is doing is taking the shipment away.
//
// Reopen is an update. It walks a shipment backwards through its state machine
// and removes nothing.
//
// Attaching a billable service stays admin-only whatever is granted. That is a
// commercial decision rather than warehouse work, which is what the comment
// below already said and what the module boundary should keep saying.
const adminOnly = authorizeRoles('admin');

// Reads
router.get('/', staffWith('read'), shipmentController.getAllShipments);
router.get('/field/:field/:value', staffWith('read'), shipmentController.getShipmentByField);
// A client sees their own shipments in the portal — the answer to "where is my
// order?", which until now the portal could not give. The controller scopes it;
// staff still read any client's.
router.get(
  '/client/:clientId',
  [
    authorizeRoles('admin', 'employee', 'client'),
    requirePermission('shipments', 'read'),
  ],
  shipmentController.getShipmentsByClientId,
);

router.post('/', staffWith('create'), shipmentController.createShipment);

// Lifecycle transitions. Each one guards the move against the state machine in
// logic/shipment.logic.js — status is not settable through PUT.
router.post('/:id/ready', staffWith('update'), shipmentController.markShipmentReady);
router.post('/:shipmentId/dispatch', staffWith('update'), shipmentController.dispatchShipment);
router.post('/:id/cancel', staffWith('delete'), shipmentController.cancelShipment);
router.post('/:id/reopen', staffWith('update'), shipmentController.reopenShipment);

// The courier consignment number. Staff, not admin-only: the person handing the
// parcel over is the one holding the label. Allowed in every status but
// CANCELLED — a courier typically issues the number at the moment of dispatch,
// so freezing it with the rest of the shipment made it unrecordable.
router.put('/:id/tracking', staffWith('update'), shipmentController.setShipmentTracking);

// Billable services on a shipment. Staff may see what will be charged; only an
// admin changes it, and only while the shipment is still PENDING.
router.get('/:id/services', staffWith('read'), shipmentServiceController.listShipmentServices);
router.post('/:id/services', adminOnly, shipmentServiceController.addShipmentService);
router.delete('/:id/services/:mappingId', adminOnly, shipmentServiceController.removeShipmentService);

// Commercial / identity details, and removal
router.put('/:id', staffWith('update'), shipmentController.updateShipment);
// What a delete would refuse on and undo — open to exactly who may delete.
router.get('/:id/dependents', staffWith('delete'), shipmentController.getShipmentDependents);
router.delete('/:id', staffWith('delete'), shipmentController.deleteShipment);

// Undoing the returns booked with the line return button. Removal rather than
// an update: it deletes what the returns did — their stock and their charges —
// so it sits with delete, as the shipment delete those returns block does.
router.get('/:id/line-returns/dependents', staffWith('delete'), shipmentController.getLineReturnDependents);
router.delete('/:id/line-returns', staffWith('delete'), shipmentController.undoLineReturns);

module.exports = router;
