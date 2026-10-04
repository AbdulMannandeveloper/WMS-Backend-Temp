'use strict';

const express = require('express');

const airFreightController = require('../controllers/air_freight.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');
const { manifestUpload, handleUploadErrors } = require('../middlewares/manifestUpload');

const router = express.Router();

// Staff-only reaches a handler only as admin/employee; requirePermission alone
// would let a client through (holdsPermission returns true for non-employees),
// so the role gate comes first on every staff route.
const staffWith = (action) => [authorizeRoles('admin', 'employee'), requirePermission('airfreight', action)];
// The portal: clients act on their own flights. Every such handler scopes by the
// caller's own clientId (404 cross-tenant), because the permission gate does not.
const staffOrClient = (action) => [
  authorizeRoles('admin', 'employee', 'client'),
  requirePermission('airfreight', action),
];
const adminOnly = authorizeRoles('admin');

// ─── Literal paths first, so none is read as an :id ─────────────────────────────

router.get('/manifest-template', staffOrClient('read'), airFreightController.manifestTemplate);

router.get('/client-settings/:clientId', adminOnly, airFreightController.getClientSettings);
router.put('/client-settings/:clientId', adminOnly, airFreightController.updateClientSettings);

// Boxes (literal /boxes/bulk-search before /boxes/:id).
router.post('/boxes/bulk-search', staffOrClient('read'), airFreightController.bulkSearchBoxes);
router.get('/boxes', staffOrClient('read'), airFreightController.listBoxes);
router.get('/boxes/:id', staffOrClient('read'), airFreightController.getBox);

// A manifest file, fetched without the flight :id in the path — scoped through
// the upload's own flight.
router.get('/uploads/:uploadId/file', staffOrClient('read'), airFreightController.getUploadFile);

// ─── Flights ─────────────────────────────────────────────────────────────────

router.get('/flights/summary', staffOrClient('read'), airFreightController.summariseFlights);
router.get('/flights', staffOrClient('read'), airFreightController.listFlights);
router.post('/flights', staffOrClient('create'), airFreightController.createFlight);

router.get('/flights/:id', staffOrClient('read'), airFreightController.getFlight);
router.patch('/flights/:id', staffOrClient('update'), airFreightController.updateFlight);
router.get('/flights/:id/dependents', staffOrClient('delete'), airFreightController.getFlightDependents);
router.delete('/flights/:id', staffOrClient('delete'), airFreightController.deleteFlight);

router.post('/flights/:id/cancel', adminOnly, airFreightController.cancelFlight);
router.post('/flights/:id/dispatch', staffOrClient('update'), airFreightController.dispatchFlight);

router.get('/flights/:id/events', staffOrClient('read'), airFreightController.flightEvents);
router.get('/flights/:id/manifest.csv', staffOrClient('read'), airFreightController.flightManifestCsv);

// ─── Manifests ──────────────────────────────────────────────────────────────

router.get('/flights/:id/uploads', staffOrClient('read'), airFreightController.listUploads);
router.post(
  '/flights/:id/uploads',
  staffOrClient('create'),
  handleUploadErrors(manifestUpload.single('file')),
  airFreightController.previewUpload,
);
router.post('/flights/:id/uploads/:uploadId/commit', staffOrClient('create'), airFreightController.commitUpload);
router.post('/flights/:id/uploads/:uploadId/discard', staffOrClient('create'), airFreightController.discardUpload);

module.exports = router;
