const { prisma } = require('../lib/prisma');

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
  getAllCategories,
  updateCategory,
  countExpensesInCategory,
  deleteCategory,
};
