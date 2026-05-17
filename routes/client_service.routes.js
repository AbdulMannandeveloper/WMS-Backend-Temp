const express = require('express');
const {
  createClientServiceEntry,
  getAllClientServices,
  getClientServicesByClientId,
  getClientServicesByServiceId,
  updateClientService,
  deleteClientService,
} = require('../controllers/client_service.controller');

const router = express.Router();

router.post('/', createClientServiceEntry);
router.get('/', getAllClientServices);
router.get('/client/:clientId', getClientServicesByClientId);
router.get('/service/:serviceId', getClientServicesByServiceId);
router.put('/:id', updateClientService);
router.delete('/:id', deleteClientService);

module.exports = router;
