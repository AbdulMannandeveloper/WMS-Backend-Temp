const express = require('express');

const fdaController = require('../controllers/fda.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Recording a consignment in and out is warehouse work. Setting up the
// categories that classify them, and voiding a mis-key, are admin decisions.
const staffOnly = authorizeRoles('admin', 'employee');
const staffOrClient = authorizeRoles('admin', 'employee', 'client');
const adminOnly = authorizeRoles('admin');

// Categories. Staff read them because they have to choose one when recording an
// arrival; only an admin decides what the list contains.
router.get('/categories', staffOnly, fdaController.listCategories);
router.post('/categories', adminOnly, fdaController.createCategory);
router.put('/categories/:id', adminOnly, fdaController.updateCategory);
router.delete('/categories/:id', adminOnly, fdaController.deleteCategory);

// Consignments. Declared after /categories so "categories" is never parsed as
// a consignment id.
router.get('/', staffOrClient, fdaController.listShipments);
router.post('/', staffOnly, fdaController.recordArrival);
router.get('/:id', staffOrClient, fdaController.getShipment);

// Leaving is what triggers the charge, so staff can do it — the same people who
// recorded it arriving.
router.post('/:id/dispatch', staffOnly, fdaController.dispatchShipment);

// Voiding one that was never really here.
router.post('/:id/cancel', adminOnly, fdaController.cancelShipment);

module.exports = router;
