const express = require('express');

const fbaController = require('../controllers/fba.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');

const router = express.Router();

// Recording a consignment in and out is warehouse work, granted per employee.
// Setting up the categories that classify them stays an admin decision.
const staffOnly = authorizeRoles('admin', 'employee');
const staffWith = (action) => [staffOnly, requirePermission('fba', action)];
const staffOrClient = authorizeRoles('admin', 'employee', 'client');
const adminOnly = authorizeRoles('admin');

// Categories. Writing them stays admin-only whatever is granted: reference data
// shaping every client's FBA records is not a per-employee decision. Reading
// them rides on fba:read, because the arrival form needs the list to offer a
// choice.
router.get('/categories', staffWith('read'), fbaController.listCategories);
router.post('/categories', adminOnly, fbaController.createCategory);
router.put('/categories/:id', adminOnly, fbaController.updateCategory);
router.delete('/categories/:id', adminOnly, fbaController.deleteCategory);

// Bulk shipments. Declared after /categories so "categories" is never parsed as
// a shipment id.
router.get('/', [staffOrClient, requirePermission('fba', 'read')], fbaController.listShipments);
// Step 1 — create the shell (DRAFT).
router.post('/', staffWith('create'), fbaController.createShipment);
router.get('/:id', [staffOrClient, requirePermission('fba', 'read')], fbaController.getShipment);

// Step 2 — scan products in (DRAFT → PREPARING). An update: it changes what the
// shipment holds, not whether it exists.
router.put('/:id/items', staffWith('update'), fbaController.setItems);

// Step 3 — dispatch (PREPARING → DISPATCHED). This is what deducts stock and
// raises the charge.
router.post('/:id/dispatch', staffWith('update'), fbaController.dispatchShipment);

// Voiding one that was never really here.
// Void is the soft-delete of a consignment, so it follows delete rather than
// update — the same call made for cancelling a shipment.
router.post('/:id/cancel', staffWith('delete'), fbaController.cancelShipment);

// Removing the record of one entirely, for a mis-key. Refused once dispatched —
// that one has been billed. (Unlike GET, this needs no ordering care against
// /categories/:id: that path is two segments and /:id is one.)
router.delete('/:id', staffWith('delete'), fbaController.deleteShipment);

module.exports = router;
