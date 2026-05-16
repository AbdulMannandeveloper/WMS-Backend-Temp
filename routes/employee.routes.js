const express = require('express');
const { addEmployee, getAllEmployees, getEmployeeById } = require('../controllers/employee.controller');

const router = express.Router();

// Admin adds a new employee; invitation email sent automatically
router.post('/', addEmployee);

// List all employees
router.get('/', getAllEmployees);

// Get a single employee by ID
router.get('/:id', getEmployeeById);

module.exports = router;
