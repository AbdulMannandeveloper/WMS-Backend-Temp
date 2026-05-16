const stockLevelController = require('../controllers/stock_level.controller');
const express = require('express');
const router = express.Router();

router.post('/', stockLevelController.createStockLevel);
router.get('/', stockLevelController.getAllStockLevels);
router.get('/product/:productId', stockLevelController.getStockLevelByProductId);
router.get('/location/:locationId', stockLevelController.getStockLevelByLocationId);
router.put('/:id', stockLevelController.updateStockLevel);
router.put('/product/:productId/location/:locationId', stockLevelController.updateStockLevelByProductAndLocation);
router.delete('/:id', stockLevelController.deleteStockLevel);

module.exports = router;