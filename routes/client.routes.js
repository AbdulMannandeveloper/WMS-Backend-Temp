const express = require('express');
const { addClient, getAllClients, getClientById } = require('../controllers/client.controller');

const router = express.Router();

// US-010 & US-011: Admin adds a new client; password-setup email sent automatically
router.post('/', addClient);

// List all clients
router.get('/', getAllClients);

// Get a single client by ID
router.get('/:id', getClientById);

module.exports = router;
