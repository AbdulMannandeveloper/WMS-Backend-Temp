const inventoryLedgerController = require('../controllers/inventory_ledger.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

// Specific named routes MUST come before wildcard /:field/:value to avoid conflicts
// US-058/059/060: GET /api/inventory-ledgers/filter?startDate=&endDate=&productId=&clientId=&movementType=
router.get('/filter', authorizeRoles('admin', 'employee'), inventoryLedgerController.getLedgerWithFilters);

// US-054: GET /api/inventory-ledgers/daily-checkout-summary?startDate=&endDate=&clientId=
router.get('/daily-checkout-summary', authorizeRoles('admin', 'employee'), inventoryLedgerController.getDailyCheckoutSummary);

// Movement totals for whatever the list is currently filtered to. Above
// /:field/:value, which would otherwise read "summary" as a column name.
router.get('/summary', authorizeRoles('admin', 'employee'), inventoryLedgerController.getInventoryLedgerSummary);

// US-063: Client-scoped ledger (clients see only their own products)
router.get('/client/:clientId', authorizeRoles('admin', 'employee', 'client'), inventoryLedgerController.getInventoryLedgerByClientId);

// Goods-in for a whole delivery. Declared above /:field/:value, which would
// otherwise swallow "batch" as a field name.
router.post('/batch', authorizeRoles('admin', 'employee'), inventoryLedgerController.checkInBatch);

router.post('/', authorizeRoles('admin', 'employee'), inventoryLedgerController.createInventoryLedgerEntry);
router.get('/', authorizeRoles('admin', 'employee'), inventoryLedgerController.getAllInventoryLedgers);
router.get('/:field/:value', authorizeRoles('admin', 'employee'), inventoryLedgerController.getInventoryLedgerByField);

module.exports = router;
