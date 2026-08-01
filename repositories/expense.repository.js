const { prisma } = require('../lib/prisma');

const prismaExpense = prisma.expense;

const createExpense = async (data) => {
  return await prismaExpense.create({
    data,
    include: { category: true },
  });
};

const getAllExpenses = async (filters = {}) => {
  const where = {};
  if (filters.categoryId) {
    where.categoryId = filters.categoryId;
  }
  if (filters.startDate || filters.endDate) {
    where.date = {};
    if (filters.startDate) {
      where.date.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      where.date.lte = new Date(filters.endDate);
    }
  }

  return await prismaExpense.findMany({
    where,
    include: { category: true },
    orderBy: { date: 'desc' },
  });
};

const getExpenseById = async (id) => {
  return await prismaExpense.findUnique({
    where: { id },
    include: { category: true },
  });
};

const updateExpense = async (id, data) => {
  return await prismaExpense.update({
    where: { id },
    data,
    include: { category: true },
  });
};

const deleteExpense = async (id) => {
  return await prismaExpense.delete({
    where: { id },
  });
};

module.exports = {
  createExpense,
  getAllExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
};
