const expenseCategoryRepository = require('../repositories/expense_category.repository');
const expenseRepository = require('../repositories/expense.repository');
const auditLogLogic = require('./audit_log.logic');

const createCategory = async (data, adminUserId) => {
  if (!data.categoryName || !data.categoryName.trim()) {
    throw new Error('Category name is required.');
  }

  const normalized = data.categoryName.trim();
  const existing = await expenseCategoryRepository.getCategoryByName(normalized);
  if (existing) {
    throw new Error('An expense category with this name already exists.');
  }

  const category = await expenseCategoryRepository.createCategory({
    categoryName: normalized,
    isSystemGenerated: false,
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'CREATE_EXPENSE_CATEGORY', {
      categoryId: category.id,
      categoryName: category.categoryName,
    }).catch(err => console.error('Audit log error:', err.message));
  }

  return category;
};

const getAllCategories = async () => {
  // Ensure the default Salaries system category exists
  let salariesCategory = await expenseCategoryRepository.getCategoryByName('Salaries');
  if (!salariesCategory) {
    await expenseCategoryRepository.createCategory({
      categoryName: 'Salaries',
      isSystemGenerated: true,
    }).catch(() => null);
  }
  return await expenseCategoryRepository.getAllCategories();
};

const createExpense = async (data, adminUserId) => {
  if (!data.categoryId || data.amount === undefined || data.amount === null || !data.date) {
    throw new Error('Category ID, amount, and date are required to create an expense.');
  }

  if (Number(data.amount) <= 0) {
    throw new Error('Expense amount must be greater than zero.');
  }

  const category = await expenseCategoryRepository.getCategoryById(data.categoryId);
  if (!category) {
    throw new Error('Referenced expense category not found.');
  }

  if (category.isSystemGenerated && category.categoryName === 'Salaries') {
    throw new Error('Salaries expenses are automatically managed and cannot be entered manually.');
  }

  const expense = await expenseRepository.createExpense({
    categoryId: data.categoryId,
    amount: Number(data.amount),
    description: data.description || '',
    date: new Date(data.date),
    receiptImageUrl: data.receiptImageUrl || null,
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'CREATE_EXPENSE', {
      expenseId: expense.id,
      categoryName: category.categoryName,
      amount: Number(expense.amount),
      description: expense.description,
    }).catch(err => console.error('Audit log error:', err.message));
  }

  return expense;
};

const getAllExpenses = async (filters = {}) => {
  return await expenseRepository.getAllExpenses(filters);
};

const deleteExpense = async (id, adminUserId) => {
  const expense = await expenseRepository.getExpenseById(id);
  if (!expense) {
    throw new Error('Expense not found.');
  }

  if (expense.category?.isSystemGenerated && expense.category?.categoryName === 'Salaries') {
    throw new Error('System generated salary expenses cannot be deleted.');
  }

  const result = await expenseRepository.deleteExpense(id);

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'DELETE_EXPENSE', {
      expenseId: id,
      categoryName: expense.category?.categoryName,
      amount: Number(expense.amount),
      description: expense.description,
    }).catch(err => console.error('Audit log error:', err.message));
  }

  return result;
};

module.exports = {
  createCategory,
  getAllCategories,
  createExpense,
  getAllExpenses,
  deleteExpense,
};
