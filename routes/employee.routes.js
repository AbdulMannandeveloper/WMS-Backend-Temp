const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const {
  addEmployee,
  getAllEmployees,
  getEmployeeLookup,
  getEmployeeById,
} = require('../controllers/employee.controller');

const router = express.Router();

// Admin adds a new employee; invitation email sent automatically
router.post('/', authorizeRoles('admin'), addEmployee);

// List all employees
router.get('/', authorizeRoles('admin'), getAllEmployees);

// Names and ids only, so staff can pick an operator when raising a shipment
// without being handed everyone's NI number and salary. Must be declared before
// '/:id' or "lookup" is swallowed as an id.
router.get('/lookup', authorizeRoles('admin', 'employee'), getEmployeeLookup);

// Get a single employee by ID. An employee may read only their own record; the
// scoping is enforced in the logic layer, not here.
router.get('/:id', authorizeRoles('admin', 'employee'), getEmployeeById);

module.exports = router;
