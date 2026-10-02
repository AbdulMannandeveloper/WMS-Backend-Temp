const express = require('express');
const expenseController = require('../controllers/expense.controller');
const upload = require('../middlewares/upload');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Expenses CRUD (Admin only)
//
// /summary sits above the /:id below it. Express matches in order, so mounted
// the other way round a request for the summary is read as a delete-by-id for
// an expense whose id is the word summary.
router.get('/summary', authorizeRoles('admin'), expenseController.getExpenseSummary);
router.get('/', authorizeRoles('admin'), expenseController.getAllExpenses);
router.post('/', authorizeRoles('admin'), expenseController.createExpense);
router.put('/:id', authorizeRoles('admin'), expenseController.updateExpense);
router.delete('/:id', authorizeRoles('admin'), expenseController.deleteExpense);

// Receipt Image Upload (Admin only)
router.post('/upload', authorizeRoles('admin'), upload.single('receipt'), expenseController.uploadReceipt);

// Receipt retrieval (Admin only) — receipts are not served as public static files
router.get('/receipt/:filename', authorizeRoles('admin'), expenseController.getReceipt);

// Expense Categories CRUD (Admin only)
router.get('/categories', authorizeRoles('admin'), expenseController.getAllCategories);
router.post('/categories', authorizeRoles('admin'), expenseController.createCategory);
router.put('/categories/:id', authorizeRoles('admin'), expenseController.updateCategory);
router.get('/categories/:id/dependents', authorizeRoles('admin'), expenseController.getCategoryDependents);
router.delete('/categories/:id', authorizeRoles('admin'), expenseController.deleteCategory);

module.exports = router;
