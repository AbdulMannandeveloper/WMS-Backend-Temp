const stockLevelController = require('../controllers/stock_level.controller');
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

const staffOnly = authorizeRoles('admin', 'employee');

// Deleting a stock row erases the record of what is in a bin. Adjusting a count
// down is the floor operation; removing the row is not — so it needs its own
// grant rather than coming free with the ability to adjust.
const staffWith = (action) => [staffOnly, requirePermission('inventory', action)];
const anyoneWith = (action) => [
  authorizeRoles('admin', 'employee', 'client'),
  requirePermission('inventory', action),
];

// Clients may read the stock list only; the controller narrows it to their own products.
// Above the /:id routes below, which would read "summary" as an id.
router.get('/summary', anyoneWith('read'), stockLevelController.getStockLevelSummary);
router.get('/', anyoneWith('read'), stockLevelController.getAllStockLevels);

router.post('/', staffWith('create'), stockLevelController.createStockLevel);
router.get('/product/:productId', staffWith('read'), stockLevelController.getStockLevelByProductId);
router.get('/location/:locationId', staffWith('read'), stockLevelController.getStockLevelByLocationId);
router.put('/:id', staffWith('update'), stockLevelController.updateStockLevel);
router.put('/product/:productId/location/:locationId', staffWith('update'), stockLevelController.updateStockLevelByProductAndLocation);
router.delete('/:id', staffWith('delete'), stockLevelController.deleteStockLevel);

module.exports = router;
