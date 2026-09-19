const { prisma } = require('../lib/prisma');

const prismaBonus = prisma.employeeBonus;

/**
 * A person, named — and nothing else. `user: true` would carry `passwordHash`
 * with it; see the same guard in employee_fine.repository.js.
 */
const userSummary = {
  select: { id: true, firstName: true, lastName: true, email: true },
};

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
    include: { user: userSummary },
    orderBy: { date: 'desc' },
  });
};

module.exports = {
  createBonus,
  getBonusById,
  getBonusesByUserAndMonth,
  getAllBonusesForMonth,
};
