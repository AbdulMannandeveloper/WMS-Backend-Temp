const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const { addClient, getAllClients, getClientById } = require('../controllers/client.controller');

const router = express.Router();

// US-010 & US-011: Admin adds a new client; password-setup email sent automatically
router.post('/', authorizeRoles('admin'), addClient);

// List all clients
router.get('/', authorizeRoles('admin'), getAllClients);

// Get a single client by ID
router.get('/:id', authorizeRoles('admin'), getClientById);

module.exports = router;
