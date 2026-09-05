const express = require('express');

const fbaController = require('../controllers/fba.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Recording a consignment in and out is warehouse work. Setting up the
// categories that classify them, and voiding a mis-key, are admin decisions.
const staffOnly = authorizeRoles('admin', 'employee');
const staffOrClient = authorizeRoles('admin', 'employee', 'client');
const adminOnly = authorizeRoles('admin');

// Categories. Staff read them because they have to choose one when recording an
// arrival; only an admin decides what the list contains.
router.get('/categories', staffOnly, fbaController.listCategories);
router.post('/categories', adminOnly, fbaController.createCategory);
router.put('/categories/:id', adminOnly, fbaController.updateCategory);
router.delete('/categories/:id', adminOnly, fbaController.deleteCategory);

// Consignments. Declared after /categories so "categories" is never parsed as
// a consignment id.
router.get('/', staffOrClient, fbaController.listShipments);
router.post('/', staffOnly, fbaController.recordArrival);
router.get('/:id', staffOrClient, fbaController.getShipment);

// Leaving is what triggers the charge, so staff can do it — the same people who
// recorded it arriving.
router.post('/:id/dispatch', staffOnly, fbaController.dispatchShipment);

// Voiding one that was never really here.
router.post('/:id/cancel', adminOnly, fbaController.cancelShipment);

// Removing the record of one entirely, for a mis-key. Refused once dispatched —
// that one has been billed. (Unlike GET, this needs no ordering care against
// /categories/:id: that path is two segments and /:id is one.)
router.delete('/:id', adminOnly, fbaController.deleteShipment);

module.exports = router;
