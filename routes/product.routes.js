const productController = require('../controllers/product.controller');
const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission, requireAnyPermission } = require('../middlewares/requirePermission');

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

// Admins and employees both operate the product catalog: warehouse staff register
// SKUs, scan barcodes and maintain threshold limits as part of daily floor work.
const staffOnly = authorizeRoles('admin', 'employee');

// Clients get read-only access, scoped in the controller to their own products.
const staffOrClient = authorizeRoles('admin', 'employee', 'client');

// Destroying a catalogue row is not floor work, and it stays that way by
// default — but it is now grantable, rather than reserved to the role.
const staffWith = (action) => [staffOnly, requirePermission('inventory', action)];

// Employee-accessible barcode/SKU lookup for the mobile check-in flow. Also the
// only way to find a product when creating a shipment, planning a bulk one or
// picking it, so those grants open it too — otherwise someone allowed to do
// that work could not find a single product to do it with.
router.get(
  '/lookup/barcode/:value',
  [
    staffOnly,
    requireAnyPermission(
      ['inventory', 'read'],
      ['shipments', 'create'],
      ['fba', 'create'],
      ['fba', 'update'],
    ),
  ],
  productController.lookupProductByBarcode,
);

router.get('/field/:field/:value', staffWith('read'), productController.getProductByField);
router.post('/', staffWith('create'), productController.createProduct);
router.get('/', [staffOrClient, requirePermission('inventory', 'read')], productController.getAllProducts);
router.get('/:id', [staffOrClient, requirePermission('inventory', 'read')], productController.getProductById);
router.put('/:id', staffWith('update'), productController.updateProduct);
// Deactivate is a soft delete in effect, but it is reversible and it is what
// staff do to a discontinued SKU all day. It stays an update.
router.patch('/:id', staffWith('update'), productController.deactivateProduct);
// What would stop a delete, asked before pressing it — open to exactly who
// may delete.
router.get('/:id/dependents', staffWith('delete'), productController.getProductDependents);
router.delete('/:id', staffWith('delete'), productController.deleteProduct);

router.get('/:id/stock', [staffOrClient, requirePermission('inventory', 'read')], productController.getProductandStockLevelById);

module.exports = router;
