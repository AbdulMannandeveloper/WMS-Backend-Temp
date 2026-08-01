const { prisma } = require('../lib/prisma');

const prismaFineRule = prisma.fineRule;

const getActiveFineRule = async () => {
  // Get the most recently created fine rule
  return await prismaFineRule.findFirst({
    orderBy: { createdAt: 'desc' },
  });
};

const createFineRule = async (data) => {
  return await prismaFineRule.create({
    data,
  });
};

const getAllFineRules = async () => {
  return await prismaFineRule.findMany({
    orderBy: { createdAt: 'desc' },
  });
};

module.exports = {
  getActiveFineRule,
  createFineRule,
  getAllFineRules,
};
