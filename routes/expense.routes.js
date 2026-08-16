const express = require('express');
const expenseController = require('../controllers/expense.controller');
const upload = require('../middlewares/upload');
const { authorizeRoles } = require('../middlewares/authorize');

const router = express.Router();

// Expenses CRUD (Admin only)
router.get('/', authorizeRoles('admin'), expenseController.getAllExpenses);
router.post('/', authorizeRoles('admin'), expenseController.createExpense);
router.delete('/:id', authorizeRoles('admin'), expenseController.deleteExpense);

// Receipt Image Upload (Admin only)
router.post('/upload', authorizeRoles('admin'), upload.single('receipt'), expenseController.uploadReceipt);

// Receipt retrieval (Admin only) — receipts are not served as public static files
router.get('/receipt/:filename', authorizeRoles('admin'), expenseController.getReceipt);

// Expense Categories CRUD (Admin only)
router.get('/categories', authorizeRoles('admin'), expenseController.getAllCategories);
router.post('/categories', authorizeRoles('admin'), expenseController.createCategory);

module.exports = router;
