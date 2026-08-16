const productController = require('../controllers/product.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

// Employee-accessible barcode/SKU lookup for the mobile check-in flow
router.get('/lookup/barcode/:value', authorizeRoles('admin', 'employee'), productController.lookupProductByBarcode);

router.get('/field/:field/:value', authorizeRoles('admin'), productController.getProductByField);
router.post('/', authorizeRoles('admin'), productController.createProduct);
router.get('/', authorizeRoles('admin'), productController.getAllProducts);
router.get('/:id', authorizeRoles('admin'), productController.getProductById);
router.put('/:id', authorizeRoles('admin'), productController.updateProduct);
router.patch('/:id', authorizeRoles('admin'), productController.deactivateProduct);
router.delete('/:id', authorizeRoles('admin'), productController.deleteProduct);

router.get('/:id/stock', authorizeRoles('admin'), productController.getProductandStockLevelById);

module.exports = router;