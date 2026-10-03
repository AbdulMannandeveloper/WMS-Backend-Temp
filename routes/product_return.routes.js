const express = require('express');

const productReturnController = require('../controllers/product_return.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');

const router = express.Router();

// Booking returns in is warehouse work, granted per employee like shipments and
// bulk shipments. Clients do not reach this module: what a return cost them
// shows on their invoice, which is where the portal already looks.
const staffOnly = authorizeRoles('admin', 'employee');
const staffWith = (action) => [staffOnly, requirePermission('returns', action)];

// Scanning a parcel is the first half of recording one, so it rides on create.
// Declared before /:id so "identify" is never read as a return id.
router.get('/identify', staffWith('create'), productReturnController.identify);
// Picking the shipment by hand when the label matched none — also part of
// recording, so also create. Before /:id for the same reason.
router.get('/lines', staffWith('create'), productReturnController.findLines);

router.get('/', staffWith('read'), productReturnController.listReturns);
router.get('/:id', staffWith('read'), productReturnController.getReturn);

// Step 1 — record: issues RET-… and raises the handling charge.
router.post('/', staffWith('create'), productReturnController.recordReturn);

// Step 2 — the disposition. Both are updates: they move an existing return to
// its final state, and restock also moves stock and raises the restock charge.
router.post('/:id/dispose', staffWith('update'), productReturnController.disposeReturn);
router.post('/:id/restock', staffWith('update'), productReturnController.restockReturn);

// Correcting the notes. Everything else was scanned or acted on; a wrong scan
// is deleted and recorded again.
router.patch('/:id', staffWith('update'), productReturnController.updateReturn);

// Deleting a return undoes it: units back off the shelf, charges off unpaid
// invoices, the shipment line's count restored. The warning shown first reads
// the same gate as the delete it describes.
router.get('/:id/dependents', staffWith('delete'), productReturnController.getReturnDependents);
router.delete('/:id', staffWith('delete'), productReturnController.deleteReturn);

module.exports = router;
