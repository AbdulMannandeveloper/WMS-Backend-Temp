const express = require('express');

const { registerFirstUser, addNewUser, getAllUsers, getUserByEmail, updateUser, deleteUser } = require('../controllers/user.controller');

const router = express.Router();

router.post('/register', registerFirstUser);
router.post('/add', addNewUser);
router.get('/', getAllUsers);
router.get('/:email', getUserByEmail);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

module.exports = router;