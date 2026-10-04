'use strict';

const express = require('express');

const airFreightController = require('../controllers/air_freight.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');
const { manifestUpload, handleUploadErrors } = require('../middlewares/manifestUpload');
const upload = require('../middlewares/upload');
const photo = (field) => handleUploadErrors(upload.single(field));

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

// ─── Phase 3: landing & customs (staff) ───────────────────────────────────────
router.post('/flights/:id/landed', staffWith('update'), airFreightController.markLanded);
router.post('/flights/:id/customs-hold', staffWith('update'), airFreightController.customsHold);
router.post('/flights/:id/customs-cleared', staffWith('update'), airFreightController.customsCleared);

// ─── Phase 4: receiving bench (staff) ─────────────────────────────────────────
router.post('/flights/:id/receive-scan', staffWith('update'), airFreightController.receiveScan);
router.post('/flights/:id/close-receipt', staffWith('update'), airFreightController.closeReceipt);
router.post('/flights/:id/reopen-receipt', adminOnly, airFreightController.reopenReceipt);
router.get('/flights/:id/sort-summary', staffWith('read'), airFreightController.sortSummary);

router.post('/boxes/:id/receive-manual', staffWith('update'), airFreightController.receiveManual);
router.patch('/boxes/:id/measurements', staffWith('update'), airFreightController.recordMeasurements);
router.post('/boxes/:id/damage', staffWith('update'), photo('photo'), airFreightController.raiseDamage);
router.post('/boxes/:id/label-issue', staffWith('update'), photo('photo'), airFreightController.raiseLabelIssue);
router.post('/boxes/:id/customs-hold', staffWith('update'), airFreightController.holdBox);
router.post('/boxes/:id/customs-release', staffWith('update'), airFreightController.releaseBox);

// ─── Phase 5: handover bench (staff; literal before :id) ──────────────────────
router.get('/handovers/ready-summary', staffWith('read'), airFreightController.readyForHandover);
router.get('/handovers', staffWith('read'), airFreightController.listHandovers);
router.post('/handovers', staffWith('create'), airFreightController.openHandover);
router.get('/handovers/:id', staffWith('read'), airFreightController.getHandover);
router.get('/handovers/:id/manifest.pdf', staffWith('read'), airFreightController.handoverManifestPdf);
router.get('/handovers/:id/proof', staffWith('read'), airFreightController.handoverProof);
router.post('/handovers/:id/scan', staffWith('update'), airFreightController.scanHandover);
router.delete('/handovers/:id/boxes/:boxId', staffWith('update'), airFreightController.removeHandoverBox);
router.post('/handovers/:id/boxes/:boxId/refuse', staffWith('update'), airFreightController.refuseHandoverBox);
router.post('/handovers/:id/close', staffWith('update'), photo('photo'), airFreightController.closeHandover);
router.post('/handovers/:id/cancel', staffWith('update'), airFreightController.cancelHandover);

module.exports = router;
