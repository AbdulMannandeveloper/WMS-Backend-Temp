const { prisma } = require('../lib/prisma');

const prismaFine = prisma.employeeFine;

const createFine = async (data) => {
  return await prismaFine.create({
    data,
  });
};

const getFineById = async (id) => {
  return await prismaFine.findUnique({
    where: { id },
  });
};

const updateFine = async (id, data) => {
  return await prismaFine.update({
    where: { id },
    data,
  });
};

const getFinesByUserAndMonth = async (userId, startOfMonth, endOfMonth) => {
  return await prismaFine.findMany({
    where: {
      userId,
      date: {
        gte: startOfMonth,
        lte: endOfMonth,
      },
    },
    orderBy: { date: 'desc' },
  });
};

const getAllFinesForMonth = async (startOfMonth, endOfMonth) => {
  return await prismaFine.findMany({
    where: {
      date: {
        gte: startOfMonth,
        lte: endOfMonth,
      },
    },
    include: { user: true },
    orderBy: { date: 'desc' },
  });
};

module.exports = {
  createFine,
  getFineById,
  updateFine,
  getFinesByUserAndMonth,
  getAllFinesForMonth,
};
