const express = require('express');
const payrollController = require('../controllers/payroll.controller');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Base Salary
router.put('/employees/:id/base-salary', authorizeRoles('admin'), payrollController.setBaseSalary);

// Fine Rules
router.post('/rules', authorizeRoles('admin'), payrollController.createFineRule);
// The rule before it comes back into force; issued fines stay.
router.delete('/rules/:id', authorizeRoles('admin'), payrollController.deleteFineRule);
router.get('/rules/active', authorizeRoles('admin', 'employee'), payrollController.getActiveFineRule);

// Fines CRUD & Cancel
router.post('/fines', authorizeRoles('admin'), payrollController.createFine);
router.patch('/fines/:id/cancel', authorizeRoles('admin'), payrollController.toggleCancelFine);
// Correcting or removing one — refused once its month is finalised for that employee.
router.put('/fines/:id', authorizeRoles('admin'), payrollController.updateFine);
router.delete('/fines/:id', authorizeRoles('admin'), payrollController.deleteFine);

// Rewards / Bonuses
router.post('/bonuses', authorizeRoles('admin'), payrollController.createBonus);
router.put('/bonuses/:id', authorizeRoles('admin'), payrollController.updateBonus);
router.delete('/bonuses/:id', authorizeRoles('admin'), payrollController.deleteBonus);

// Breakdown Summaries
router.get('/my-summary', authorizeRoles('admin', 'employee'), payrollController.getSalaryBreakdownForEmployee);
router.get('/summary', authorizeRoles('admin'), payrollController.getSalarySummaryForAll);

// Finalize Month
router.post('/finalize', authorizeRoles('admin'), payrollController.finalizePayroll);

module.exports = router;
