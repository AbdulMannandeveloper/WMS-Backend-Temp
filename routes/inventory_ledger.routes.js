const inventoryLedgerController = require('../controllers/inventory_ledger.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');

/**
 * Inventory is governed per employee now.
 *
 * Each guard below is authorizeRoles followed by requirePermission: the first
 * decides whether the caller is staff at all, the second whether this
 * particular employee was granted this action. An admin passes the second
 * without consulting anything, and a client falls through it to the scoping
 * that already narrows client reads.
 *
 * Deletes were admin-only. They are open to an employee holding
 * inventory:delete now, which is what makes that permission mean something —
 * before this, no employee could delete anything, so a delete tickbox would
 * have been a control that did nothing.
 */
const router = express.Router();

const staffWith = (action) => [
  authorizeRoles('admin', 'employee'),
  requirePermission('inventory', action),
];

// The ledger has no update or delete routes, and should not: an entry records
// something that happened. A mistake is corrected with an ADJUSTMENT movement,
// which is a create. So inventory:update and inventory:delete govern products
// and stock rows only.


// Specific named routes MUST come before wildcard /:field/:value to avoid conflicts
// US-058/059/060: GET /api/inventory-ledgers/filter?startDate=&endDate=&productId=&clientId=&movementType=
router.get('/filter', staffWith('read'), inventoryLedgerController.getLedgerWithFilters);

// US-054: GET /api/inventory-ledgers/daily-checkout-summary?startDate=&endDate=&clientId=
router.get('/daily-checkout-summary', staffWith('read'), inventoryLedgerController.getDailyCheckoutSummary);

// Movement totals for whatever the list is currently filtered to. Above
// /:field/:value, which would otherwise read "summary" as a column name.
router.get('/summary', staffWith('read'), inventoryLedgerController.getInventoryLedgerSummary);

// US-063: Client-scoped ledger (clients see only their own products)
router.get('/client/:clientId', [authorizeRoles('admin', 'employee', 'client'), requirePermission('inventory', 'read')], inventoryLedgerController.getInventoryLedgerByClientId);

// Goods-in for a whole delivery. Declared above /:field/:value, which would
// otherwise swallow "batch" as a field name.
router.post('/batch', staffWith('create'), inventoryLedgerController.checkInBatch);

router.post('/', staffWith('create'), inventoryLedgerController.createInventoryLedgerEntry);
router.get('/', staffWith('read'), inventoryLedgerController.getAllInventoryLedgers);
router.get('/:field/:value', staffWith('read'), inventoryLedgerController.getInventoryLedgerByField);

module.exports = router;
