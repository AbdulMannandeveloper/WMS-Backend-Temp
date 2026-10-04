'use strict';

const express = require('express');

const courierController = require('../controllers/courier.controller');
const { authorizeRoles } = require('../middlewares/authorize');
const { requirePermission } = require('../middlewares/requirePermission');

const router = express.Router();

// Reading the courier list is open to clients too: they need the valid codes to
// fill in a manifest. The controller trims their view to id/code/name. Writing
// couriers and depots is reference-data work and stays admin-only, whatever an
// employee has been granted on air freight.
const canRead = [
  authorizeRoles('admin', 'employee', 'client'),
  requirePermission('airfreight', 'read'),
];
const adminOnly = authorizeRoles('admin');

router.get('/', canRead, courierController.listCouriers);
router.post('/', adminOnly, courierController.createCourier);

router.get('/:id/dependents', adminOnly, courierController.getCourierDependents);
router.put('/:id', adminOnly, courierController.updateCourier);
router.delete('/:id', adminOnly, courierController.deleteCourier);

router.post('/:id/depots', adminOnly, courierController.addDepot);
router.put('/depots/:depotId', adminOnly, courierController.updateDepot);
router.delete('/depots/:depotId', adminOnly, courierController.deleteDepot);

module.exports = router;
