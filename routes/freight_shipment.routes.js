'use strict';

const express = require('express');

const freightController = require('../controllers/freight_shipment.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');
const upload = require('../middlewares/upload');

const router = express.Router();

/**
 * Freight is staff work, granted per employee.
 *
 * There is no staffOrClient here, unlike shipments and FBA. A freight sender is a
 * private person who walked into a shop in Pakistan, not a WMS client with a
 * portal login, so there is no tenant to scope these rows to and nobody outside
 * the warehouse who should read them.
 */
const staffOnly = authorizeRoles('admin', 'employee');
const staffWith = (action) => [staffOnly, requirePermission('freight', action)];

// Literal segments first. /summary, /lookup and /documents all have to be
// declared above /:id, or Express parses "summary" as a shipment id and the
// handler answers 404 for a route that exists — a mistake this codebase has made
// more than once.
router.get('/summary', staffWith('read'), freightController.getFreightShipmentSummary);

// What the gun read. Two segments under /lookup so it cannot collide with /:id.
router.get(
  '/lookup/barcode/:value',
  staffWith('read'),
  freightController.lookupFreightShipmentByBarcode,
);

// Booking slips, served through an authenticated route rather than statically.
router.get('/documents/:filename', staffWith('read'), freightController.getFreightDocument);

router.get('/', staffWith('read'), freightController.getAllFreightShipments);
router.post('/', staffWith('create'), freightController.createFreightShipment);

router.get('/:id', staffWith('read'), freightController.getFreightShipment);
router.get('/:id/history', staffWith('read'), freightController.getFreightShipmentHistory);

router.put('/:id', staffWith('update'), freightController.updateFreightShipment);

// Attaching the booking receipt is editing the shipment, not creating one: the
// shipment already exists by the time a file can be hung off it.
router.post(
  '/:id/documents',
  [...staffWith('update'), upload.single('document')],
  freightController.uploadFreightDocument,
);
router.delete(
  '/:id/documents/:documentId',
  staffWith('update'),
  freightController.removeFreightDocument,
);

// Dispatch and receive are updates. They change what has happened to the
// shipment, not whether it exists — the same reading that puts mark-ready and
// dispatch under shipments:update.
router.post('/:id/dispatch', staffWith('update'), freightController.dispatchFreightShipment);
router.post('/:id/receive', staffWith('update'), freightController.receiveFreightShipment);

// Cancel is a delete. It is the soft-delete of a freight shipment, so it follows
// delete rather than update — the same call made for cancelling a shipment.
router.post('/:id/cancel', staffWith('delete'), freightController.cancelFreightShipment);

// Removing the record entirely, for a mis-key. Refused once received (except
// to an admin in testing mode). The warning shown first reads the same gate as
// the delete it describes.
router.get('/:id/dependents', staffWith('delete'), freightController.getFreightShipmentDependents);
router.delete('/:id', staffWith('delete'), freightController.deleteFreightShipment);

module.exports = router;
