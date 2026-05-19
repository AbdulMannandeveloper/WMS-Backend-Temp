const express = require('express');
const { addEmployee, getAllEmployees, getEmployeeById } = require('../controllers/employee.controller');

const router = express.Router();

// Admin adds a new employee; invitation email sent automatically
router.post('/', authorizeRoles('admin'), addEmployee);

// List all employees
router.get('/', authorizeRoles('admin'), getAllEmployees);

// Get a single employee by ID
router.get('/:id', authorizeRoles('admin', 'employee'), getEmployeeById);

module.exports = router;
