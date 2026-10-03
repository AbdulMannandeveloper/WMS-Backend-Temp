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

const getFineRuleById = async (id) => {
  return await prismaFineRule.findUnique({ where: { id } });
};

const deleteFineRule = async (id) => {
  return await prismaFineRule.delete({ where: { id } });
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
  getFineRuleById,
  deleteFineRule,
};
