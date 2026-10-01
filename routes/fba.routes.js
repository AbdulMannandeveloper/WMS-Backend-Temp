const express = require('express');

const fbaController = require('../controllers/fba.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission, requireAnyPermission } = require('../middlewares/requirePermission');

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

// The services a client can have attached — for the create form (fba:create)
// and for changing them afterwards (fba:update).
router.get(
  '/client-services/:clientId',
  [staffOnly, requireAnyPermission(['fba', 'create'], ['fba', 'update'])],
  fbaController.listAttachableServices,
);

// Bulk shipments. Declared after /categories so "categories" is never parsed as
// a shipment id.
router.get('/', [staffOrClient, requirePermission('fba', 'read')], fbaController.listShipments);
// Step 1 — create it with its planned products (PREPARING; DRAFT if empty).
router.post('/', staffWith('create'), fbaController.createShipment);
router.get('/:id', [staffOrClient, requirePermission('fba', 'read')], fbaController.getShipment);
router.get(
  '/:id/delivery-note',
  [staffOrClient, requirePermission('fba', 'read')],
  fbaController.getDeliveryNote,
);

// Editing a shipment's details (client, category, destination, delivery note,
// tracking number) after it is opened. Admin-only whatever is granted: a
// correction to a record other people have already worked from.
router.put('/:id', adminOnly, fbaController.updateShipment);

// Moving it to another client, before dispatch — for putting right a client
// chosen by mistake without waiting on an admin. fba:create or fba:update:
// whoever raises shipments or edits them. Anything it would remove has to be
// confirmed (see updateBulkShipment).
router.put(
  '/:id/client',
  [staffOnly, requireAnyPermission(['fba', 'create'], ['fba', 'update'])],
  fbaController.changeClient,
);

// Changing the planned products (DRAFT ⇄ PREPARING). An update: it changes what
// the shipment holds, not whether it exists.
router.put('/:id/items', staffWith('update'), fbaController.setItems);

// Replacing the attached services after creation, before dispatch. fba:update,
// the same as changing its products: both change what the client is charged,
// and both are fixed once it is dispatched.
router.put('/:id/services', staffWith('update'), fbaController.setServices);

// Step 2 — record what the floor has picked against the plan.
router.put('/:id/picks', staffWith('update'), fbaController.setPicks);

// Step 3 — dispatch (PREPARING → DISPATCHED), once fully picked. This is what
// deducts stock and raises the charge.
router.post('/:id/dispatch', staffWith('update'), fbaController.dispatchShipment);

// The tracking number, before or after dispatch — couriers usually issue it at
// the hand-over. fba:update, like dispatching; refused only once voided.
router.put('/:id/tracking', staffWith('update'), fbaController.setTracking);

// Goods that went out and came back, part or all of a dispatched line. An
// update: the line survives, its returned count grows. Stock goes back to its
// bin; the dispatch charge is never changed.
router.post('/:id/items/:itemId/return', staffWith('update'), fbaController.returnItem);

// Voiding one that was never really here.
// Void is the soft-delete of a consignment, so it follows delete rather than
// update — the same call made for cancelling a shipment.
router.post('/:id/cancel', staffWith('delete'), fbaController.cancelShipment);

// Removing the record of one entirely, for a mis-key. Admin-only whatever is
// granted — fba:delete still opens voiding, which keeps the record. Allowed at
// any status; a dispatched one has its stock put back and its charges taken off
// the invoice, and is refused once that invoice is paid. (Unlike GET, this
// needs no ordering care against /categories/:id: that path is two segments
// and /:id is one.)
router.delete('/:id', adminOnly, fbaController.deleteShipment);

module.exports = router;
