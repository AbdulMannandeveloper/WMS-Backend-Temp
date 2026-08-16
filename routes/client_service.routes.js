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

router.use(authorizeRoles('admin'));

router.post('/', createClientServiceEntry);
router.get('/', getAllClientServices);
router.get('/client/:clientId', getClientServicesByClientId);
router.get('/service/:serviceId', getClientServicesByServiceId);
router.put('/:id', updateClientService);
router.delete('/:id', deleteClientService);

module.exports = router;
