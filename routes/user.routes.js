const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');

const { addNewUser, getAllUsers, getUserByEmail, updateUser, getUserDependents, deleteUser } = require('../controllers/user.controller');

const router = express.Router();

router.post('/add', authorizeRoles('admin'), addNewUser);
router.get('/', authorizeRoles('admin'), getAllUsers);
router.get('/:email', authorizeRoles('admin'), getUserByEmail);
router.put('/:id', authorizeRoles('admin'), updateUser);

// Deleting a login is refused while records still name it; /dependents says
// which, so the admin sees them before pressing delete. Serves the Users and
// Employees screens alike — an employee is deleted by deleting their login.
router.get('/:id/dependents', authorizeRoles('admin'), getUserDependents);
router.delete('/:id', authorizeRoles('admin'), deleteUser);

module.exports = router;