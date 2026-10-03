const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const {
  addClient,
  getAllClients,
  getClientLookup,
  getMyClient,
  getClientById,
  updateClient,
  getClientDependents,
  setClientActive,
  deleteClient,
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

// Editing a client's details. The controller and logic for these have existed
// all along with no route pointing at them, so a client's company name, contact
// or address could never be corrected after creation.
router.put('/:id', authorizeRoles('admin'), updateClient);

// Deleting is refused while anything still refers to the client; /dependents
// says what, so the admin sees it before pressing delete. Deactivating keeps
// every record and only switches the login off.
router.get('/:id/dependents', authorizeRoles('admin'), getClientDependents);
router.patch('/:id/active', authorizeRoles('admin'), setClientActive);
router.delete('/:id', authorizeRoles('admin'), deleteClient);

module.exports = router;
