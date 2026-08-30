const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const {
  addClient,
  getAllClients,
  getClientLookup,
  getMyClient,
  getClientById,
} = require('../controllers/client.controller');

const router = express.Router();

// US-010 & US-011: Admin adds a new client; password-setup email sent automatically
router.post('/', authorizeRoles('admin'), addClient);

// Named routes must be registered before /:id so they are not swallowed by it.

// A client reads its own business profile (client portal).
router.get('/me', authorizeRoles('client'), getMyClient);

// Slim id + companyName list so employees can attribute products to a client
// without gaining access to contact details.
router.get('/lookup', authorizeRoles('admin', 'employee'), getClientLookup);

// List all clients (full records, admin only)
router.get('/', authorizeRoles('admin'), getAllClients);

// Get a single client by ID
router.get('/:id', authorizeRoles('admin'), getClientById);

module.exports = router;
