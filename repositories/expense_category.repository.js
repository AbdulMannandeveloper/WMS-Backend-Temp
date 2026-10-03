const { prisma } = require('../lib/prisma');
const { equalsIgnoringCase } = require('../utils/identifiers');

const prismaCategory = prisma.expenseCategory;

const createCategory = async (data) => {
  return await prismaCategory.create({
    data,
  });
};

const getCategoryById = async (id, tx) => {
  return await (tx ? tx.expenseCategory : prismaCategory).findUnique({
    where: { id },
  });
};

const getCategoryByName = async (categoryName) => {
  return await prismaCategory.findUnique({
    where: { categoryName },
  });
};

/**
 * The category a new or renamed one would clash with: `Fuel` and `fuel` are
 * one category, and the database agrees (migration 20261003150000).
 *
 * Separate from getCategoryByName on purpose. Payroll finds its own Salaries
 * category by that exact name, and must keep finding the system one rather
 * than whichever row happens to spell it the same way.
 */
const findCategoryIgnoringCase = async (categoryName) => {
  return await prismaCategory.findFirst({
    where: { categoryName: equalsIgnoringCase(categoryName) },
  });
};

const getAllCategories = async () => {
  return await prismaCategory.findMany({
    orderBy: { categoryName: 'asc' },
  });
};

const updateCategory = async (id, data) => {
  return await prismaCategory.update({
    where: { id },
    data,
  });
};

const countExpensesInCategory = async (categoryId, tx) => {
  return await (tx ?? prisma).expense.count({ where: { categoryId } });
};

const deleteCategory = async (id, tx) => {
  return await (tx ? tx.expenseCategory : prismaCategory).delete({
    where: { id },
  });
};

module.exports = {
  createCategory,
  getCategoryById,
  getCategoryByName,
  findCategoryIgnoringCase,
  getAllCategories,
  updateCategory,
  countExpensesInCategory,
  deleteCategory,
};
