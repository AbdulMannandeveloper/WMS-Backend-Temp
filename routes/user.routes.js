const express = require('express');

const { getAllUsers, getUserByEmail, updateUser, deleteUser } = require('../controllers/user.controller');

const router = express.Router();

// DEPRECATED: User creation moved to /auth/admin/users/invite endpoint
// This endpoint is consolidated into the invite flow for consistency
// router.post('/add', addNewUser);
router.get('/', getAllUsers);
router.get('/:email', getUserByEmail);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

module.exports = router;