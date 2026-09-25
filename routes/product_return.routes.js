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

router.get('/', staffWith('read'), productReturnController.listReturns);
router.get('/:id', staffWith('read'), productReturnController.getReturn);

// Step 1 — record: issues RET-… and raises the handling charge.
router.post('/', staffWith('create'), productReturnController.recordReturn);

// Step 2 — the disposition. Both are updates: they move an existing return to
// its final state, and restock also moves stock and raises the restock charge.
router.post('/:id/dispose', staffWith('update'), productReturnController.disposeReturn);
router.post('/:id/restock', staffWith('update'), productReturnController.restockReturn);

module.exports = router;
