const stockLevelController = require('../controllers/stock_level.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

const staffOnly = authorizeRoles('admin', 'employee');

// Clients may read the stock list only; the controller narrows it to their own products.
router.get('/', authorizeRoles('admin', 'employee', 'client'), stockLevelController.getAllStockLevels);

router.post('/', staffOnly, stockLevelController.createStockLevel);
router.get('/product/:productId', staffOnly, stockLevelController.getStockLevelByProductId);
router.get('/location/:locationId', staffOnly, stockLevelController.getStockLevelByLocationId);
router.put('/:id', staffOnly, stockLevelController.updateStockLevel);
router.put('/product/:productId/location/:locationId', staffOnly, stockLevelController.updateStockLevelByProductAndLocation);
router.delete('/:id', staffOnly, stockLevelController.deleteStockLevel);

module.exports = router;
