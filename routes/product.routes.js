const productController = require('../controllers/product.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const router = express.Router();

// Admins and employees both operate the product catalog: warehouse staff register
// SKUs, scan barcodes and maintain threshold limits as part of daily floor work.
const staffOnly = authorizeRoles('admin', 'employee');

// Clients get read-only access, scoped in the controller to their own products.
const staffOrClient = authorizeRoles('admin', 'employee', 'client');

// Employee-accessible barcode/SKU lookup for the mobile check-in flow
router.get('/lookup/barcode/:value', staffOnly, productController.lookupProductByBarcode);

router.get('/field/:field/:value', staffOnly, productController.getProductByField);
router.post('/', staffOnly, productController.createProduct);
router.get('/', staffOrClient, productController.getAllProducts);
router.get('/:id', staffOrClient, productController.getProductById);
router.put('/:id', staffOnly, productController.updateProduct);
router.patch('/:id', staffOnly, productController.deactivateProduct);
router.delete('/:id', staffOnly, productController.deleteProduct);

router.get('/:id/stock', staffOrClient, productController.getProductandStockLevelById);

module.exports = router;
