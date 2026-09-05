const stockLevelController = require('../controllers/stock_level.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

const staffOnly = authorizeRoles('admin', 'employee');

// Deleting a stock row erases the record of what is in a bin. Adjusting a count
// down is the floor operation; removing the row is not.
const adminOnly = authorizeRoles('admin');

// Clients may read the stock list only; the controller narrows it to their own products.
router.get('/', authorizeRoles('admin', 'employee', 'client'), stockLevelController.getAllStockLevels);

router.post('/', staffOnly, stockLevelController.createStockLevel);
router.get('/product/:productId', staffOnly, stockLevelController.getStockLevelByProductId);
router.get('/location/:locationId', staffOnly, stockLevelController.getStockLevelByLocationId);
router.put('/:id', staffOnly, stockLevelController.updateStockLevel);
router.put('/product/:productId/location/:locationId', staffOnly, stockLevelController.updateStockLevelByProductAndLocation);
router.delete('/:id', adminOnly, stockLevelController.deleteStockLevel);

module.exports = router;
