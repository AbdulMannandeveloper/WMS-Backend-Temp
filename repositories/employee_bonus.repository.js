const { prisma } = require('../lib/prisma');

const prismaBonus = prisma.employeeBonus;

const createBonus = async (data) => {
  return await prismaBonus.create({
    data,
  });
};

const getBonusById = async (id) => {
  return await prismaBonus.findUnique({
    where: { id },
  });
};

const getBonusesByUserAndMonth = async (userId, startOfMonth, endOfMonth) => {
  return await prismaBonus.findMany({
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

const getAllBonusesForMonth = async (startOfMonth, endOfMonth) => {
  return await prismaBonus.findMany({
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
  createBonus,
  getBonusById,
  getBonusesByUserAndMonth,
  getAllBonusesForMonth,
};
