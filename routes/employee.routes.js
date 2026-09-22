const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
const {
  addEmployee,
  getAllEmployees,
  getEmployeeLookup,
  getEmployeeById,
  updateEmployee,
  getEmployeePermissions,
  setEmployeePermissions,
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

// Employment details: job title, NI number, date of birth, wage rate, address.
// Admin only — an employee may read their own record but not edit it, and this
// is the most sensitive data the system holds about staff.
//
// Base salary is not here. Payroll owns that, and it is the figure payroll
// multiplies into net pay; two screens writing one number is how they drift.
router.put('/:id', authorizeRoles('admin'), updateEmployee);

// What this employee may do in Shipments, FBA and Inventory.
//
// Its own endpoint rather than a field on the update above, which allowlists
// five employment details and deliberately left baseSalary to a dedicated
// payroll route. A field controlling access does not belong in the same request
// as a home address.
//
// The read is open to an employee for their own record — the front end asks at
// sign-in to decide what to offer — and the ownership check lives in the logic
// layer, as it does for GET /:id above.
router.get('/:id/permissions', authorizeRoles('admin', 'employee'), getEmployeePermissions);
router.put('/:id/permissions', authorizeRoles('admin'), setEmployeePermissions);

module.exports = router;
