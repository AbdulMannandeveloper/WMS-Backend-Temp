const { prisma } = require('../lib/prisma');

const prismaCategory = prisma.expenseCategory;

const createCategory = async (data) => {
  return await prismaCategory.create({
    data,
  });
};

const getCategoryById = async (id) => {
  return await prismaCategory.findUnique({
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

const deleteCategory = async (id) => {
  return await prismaCategory.delete({
    where: { id },
  });
};

module.exports = {
  createCategory,
  getCategoryById,
  getCategoryByName,
  getAllCategories,
  deleteCategory,
};
