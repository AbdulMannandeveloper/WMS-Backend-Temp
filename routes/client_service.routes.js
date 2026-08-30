const express = require('express');
const {
  createClientServiceEntry,
  getAllClientServices,
  getClientServicesByClientId,
  getClientServicesByServiceId,
  updateClientService,
  deleteClientService,
} = require('../controllers/client_service.controller');

const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

const adminOnly = authorizeRoles('admin');

// A client reads its own assigned services in the portal; the controller verifies
// ownership of :clientId. Everything else stays admin-only.
router.get('/client/:clientId', authorizeRoles('admin', 'client'), getClientServicesByClientId);

router.post('/', adminOnly, createClientServiceEntry);
router.get('/', adminOnly, getAllClientServices);
router.get('/service/:serviceId', adminOnly, getClientServicesByServiceId);
router.put('/:id', adminOnly, updateClientService);
router.delete('/:id', adminOnly, deleteClientService);

module.exports = router;
