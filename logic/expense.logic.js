const expenseCategoryRepository = require('../repositories/expense_category.repository');
const expenseRepository = require('../repositories/expense.repository');
const auditLogLogic = require('./audit_log.logic');
const { buildReport, assertDeletable } = require('../utils/dependents');
const { removeStoredFile } = require('../lib/objectStorage');

/** How the receipt upload names a stored receipt (expense.controller uploadReceipt). */
const RECEIPT_URL_PREFIX = '/api/expenses/receipt/';

/**
 * Removes a receipt's stored file once no expense points at it any more.
 * Called after the change that let go of it has been saved. A URL this system
 * did not issue is left alone: there is no file of ours behind it.
 */
const releaseReceipt = async (receiptImageUrl) => {
  if (!receiptImageUrl || !receiptImageUrl.startsWith(RECEIPT_URL_PREFIX)) return;
  if ((await expenseRepository.countByReceipt(receiptImageUrl)) > 0) return;
  await removeStoredFile(receiptImageUrl.slice(RECEIPT_URL_PREFIX.length));
};
const {
  dateRangeFilter,
  parseBoolean,
  parseString,
  parseUuid,
  rangeFilter,
  searchFilter,
} = require('../utils/queryFilters');

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

/**
 * The Salaries category belongs to payroll: finalising a month files its total
 * under it, by name. Renaming it would make the next finalise create a second
 * one, and its expenses are payroll's to change, not this screen's.
 */
const isSalaries = (category) =>
  Boolean(category?.isSystemGenerated && category.categoryName === 'Salaries');

const updateCategory = async (id, data, adminUserId) => {
  const category = await expenseCategoryRepository.getCategoryById(id);
  if (!category) throw new Error('Expense category not found.');
  if (category.isSystemGenerated) {
    throw new Error(`"${category.categoryName}" is built in and cannot be renamed.`);
  }

  const normalized = String(data?.categoryName ?? '').trim();
  if (!normalized) throw new Error('Category name is required.');
  if (normalized.length > 80) throw new Error('Category name is too long — 80 characters maximum.');
  if (normalized === category.categoryName) return category;

  const clash = await expenseCategoryRepository.getCategoryByName(normalized);
  if (clash && clash.id !== id) {
    throw new Error('An expense category with this name already exists.');
  }

  const updated = await expenseCategoryRepository.updateCategory(id, { categoryName: normalized });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'UPDATE_EXPENSE_CATEGORY', {
      categoryId: id,
      from: category.categoryName,
      to: normalized,
    }).catch(err => console.error('Audit log error:', err.message));
  }

  return updated;
};

/**
 * What deleting a category would refuse on: the expenses filed under it, which
 * cannot be left without one — moved to another category with Edit, or
 * deleted — and, for a built-in category, the fact that it is built in.
 */
const getCategoryDependents = async (id) => {
  const category = await expenseCategoryRepository.getCategoryById(id);
  if (!category) throw new Error('Expense category not found.');
  const inUse = await expenseCategoryRepository.countExpensesInCategory(id);
  return {
    category,
    report: buildReport({
      blocking: [
        {
          key: 'builtIn',
          label: 'Built-in category',
          count: category.isSystemGenerated ? 1 : 0,
          note: 'Payroll files salaries under it, so it is kept.',
        },
        {
          key: 'expenses',
          label: 'Expenses in it',
          count: inUse,
          where: '/expenses',
          note: 'Move each to another category with Edit, or delete it.',
        },
      ],
    }),
  };
};

const deleteCategory = async (id, adminUserId) => {
  const { category, report } = await getCategoryDependents(id);
  assertDeletable(`"${category.categoryName}"`, report);

  await expenseCategoryRepository.deleteCategory(id);

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'DELETE_EXPENSE_CATEGORY', {
      categoryId: id,
      categoryName: category.categoryName,
    }).catch(err => console.error('Audit log error:', err.message));
  }

  return { message: 'Expense category deleted.' };
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

/**
 * What the expense list may be narrowed by.
 *
 * Exported so the /summary handler derives its where from the same object and
 * the same req.query. The cards above the table and the rows in it then cannot
 * describe different sets, because neither side decides independently what a
 * filter means.
 */
const EXPENSE_LIST_SPEC = {
  filters: [
    (q) => searchFilter(q.search, ['description', 'category.categoryName']),
    (q) => {
      const categoryId = parseUuid(q.categoryId, 'categoryId');
      return categoryId ? { categoryId } : undefined;
    },
    (q) => {
      // date is @db.Date, so the end bound stays at midnight: the column
      // stores the day, and stretching it to 23:59 would describe a precision
      // the column does not have.
      const range = dateRangeFilter(q.startDate, q.endDate, { granularity: 'date' });
      return range ? { date: range } : undefined;
    },
    (q) => {
      const range = rangeFilter(q.amountMin, q.amountMax, { label: 'amount' });
      return range ? { amount: range } : undefined;
    },
    (q) => {
      const hasReceipt = parseBoolean(q.hasReceipt, 'hasReceipt');
      if (hasReceipt === undefined) return undefined;
      return hasReceipt
        ? { receiptImageUrl: { not: null } }
        : { receiptImageUrl: null };
    },
  ],
  sort: {
    allowed: {
      date: (order) => ({ date: order }),
      amount: (order) => ({ amount: order }),
      description: (order) => ({ description: order }),
      categoryName: (order) => ({ category: { categoryName: order } }),
    },
    defaultSort: { field: 'date', order: 'desc' },
    tiebreaker: [{ id: 'asc' }],
  },
};

const getAllExpenses = async (where, options) =>
  await expenseRepository.getAllExpenses(where, options);

const summariseExpenses = async (where) =>
  await expenseRepository.summariseExpenses(where);

/** What an expense edit may change. Everything else is the row's identity. */
const EXPENSE_UPDATE_FIELDS = ['categoryId', 'amount', 'description', 'date', 'receiptImageUrl'];

/**
 * Corrects a manual expense. Salary expenses are refused, as their delete is:
 * payroll finalising a month writes them, and recomputes them if it runs
 * again. Nothing may be moved into Salaries either, for the same reason.
 */
const updateExpense = async (id, raw, adminUserId) => {
  const expense = await expenseRepository.getExpenseById(id);
  if (!expense) throw new Error('Expense not found.');
  if (isSalaries(expense.category)) {
    throw new Error('Salaries expenses are managed by payroll and cannot be edited here.');
  }

  const input = raw || {};
  const data = {};
  for (const field of EXPENSE_UPDATE_FIELDS) {
    if (field in input) data[field] = input[field];
  }

  if ('categoryId' in data) {
    const category = await expenseCategoryRepository.getCategoryById(data.categoryId);
    if (!category) throw new Error('Referenced expense category not found.');
    if (isSalaries(category)) {
      throw new Error('Salaries expenses are automatically managed and cannot be entered manually.');
    }
  }
  if ('amount' in data) {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Expense amount must be greater than zero.');
    }
    data.amount = amount;
  }
  if ('date' in data) {
    const date = new Date(data.date);
    if (!data.date || Number.isNaN(date.getTime())) throw new Error('A valid date is required.');
    data.date = date;
  }
  if ('description' in data) data.description = String(data.description ?? '').trim();
  if ('receiptImageUrl' in data) data.receiptImageUrl = data.receiptImageUrl || null;

  if (Object.keys(data).length === 0) return expense;

  const updated = await expenseRepository.updateExpense(id, data);
  // Replaced or removed: the old file goes, unless another expense uses it.
  if ('receiptImageUrl' in data && expense.receiptImageUrl !== data.receiptImageUrl) {
    await releaseReceipt(expense.receiptImageUrl);
  }

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'UPDATE_EXPENSE', {
      expenseId: id,
      changed: Object.keys(data),
      from: Object.fromEntries(
        Object.keys(data).map((key) => [key, key === 'amount' ? Number(expense[key]) : expense[key] ?? null]),
      ),
      to: data,
    }).catch(err => console.error('Audit log error:', err.message));
  }

  return updated;
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
  await releaseReceipt(expense.receiptImageUrl);

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
  EXPENSE_LIST_SPEC,
  summariseExpenses,
  createCategory,
  getAllCategories,
  updateCategory,
  getCategoryDependents,
  deleteCategory,
  createExpense,
  getAllExpenses,
  updateExpense,
  deleteExpense,
};
