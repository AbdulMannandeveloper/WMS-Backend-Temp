const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');

const { addNewUser, getAllUsers, getUserByEmail, updateUser, deleteUser } = require('../controllers/user.controller');

const router = express.Router();

router.post('/add', authorizeRoles('admin'), addNewUser);
router.get('/', authorizeRoles('admin'), getAllUsers);
router.get('/:email', authorizeRoles('admin'), getUserByEmail);
router.put('/:id', authorizeRoles('admin'), updateUser);
router.delete('/:id', authorizeRoles('admin'), deleteUser);

module.exports = router;