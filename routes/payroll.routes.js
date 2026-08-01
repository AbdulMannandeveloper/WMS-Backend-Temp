const express = require('express');
const payrollController = require('../controllers/payroll.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Base Salary
router.put('/employees/:id/base-salary', authorizeRoles('admin'), payrollController.setBaseSalary);

// Fine Rules
router.post('/rules', authorizeRoles('admin'), payrollController.createFineRule);
router.get('/rules/active', authorizeRoles('admin', 'employee'), payrollController.getActiveFineRule);

// Fines CRUD & Cancel
router.post('/fines', authorizeRoles('admin'), payrollController.createFine);
router.patch('/fines/:id/cancel', authorizeRoles('admin'), payrollController.toggleCancelFine);

// Rewards / Bonuses
router.post('/bonuses', authorizeRoles('admin'), payrollController.createBonus);

// Breakdown Summaries
router.get('/my-summary', authorizeRoles('admin', 'employee'), payrollController.getSalaryBreakdownForEmployee);
router.get('/summary', authorizeRoles('admin'), payrollController.getSalarySummaryForAll);

// Finalize Month
router.post('/finalize', authorizeRoles('admin'), payrollController.finalizePayroll);

module.exports = router;
