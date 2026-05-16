const productController = require('../controllers/product.controller');
const express = require('express');
const router = express.Router();

router.post('/', productController.createProduct);
router.get('/', productController.getAllProducts);
router.get('/:id', productController.getProductById);
router.get('/field/:field/:value', productController.getProductByField);
router.put('/:id', productController.updateProduct);
router.patch('/:id', productController.deactivateProduct);
// router.delete('/:id', productController.deleteProduct);

router.get('/:id/stock', productController.getProductandStockLevelById);

module.exports = router;