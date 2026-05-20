const inventoryLedgerController = require('../controllers/inventory_ledger.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

router.post('/', authorizeRoles('admin', 'employee'), inventoryLedgerController.createInventoryLedgerEntry);
router.get('/', authorizeRoles('admin', 'employee'), inventoryLedgerController.getAllInventoryLedgers);
router.get('/:field/:value', authorizeRoles('admin', 'employee'), inventoryLedgerController.getInventoryLedgerByField);
router.get('/client/:clientId', authorizeRoles('admin', 'employee'), inventoryLedgerController.getInventoryLedgerByClientId);

module.exports = router;