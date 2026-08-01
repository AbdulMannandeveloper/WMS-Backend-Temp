const { prisma } = require('../lib/prisma');

const prismaPayroll = prisma.payrollRecord;

const createPayrollRecord = async (data) => {
  return await prismaPayroll.create({
    data,
    include: { user: { include: { employee: true } } },
  });
};

const getPayrollRecordById = async (id) => {
  return await prismaPayroll.findUnique({
    where: { id },
    include: { user: { include: { employee: true } } },
  });
};

const getPayrollRecordByUserAndMonth = async (userId, monthYear) => {
  return await prismaPayroll.findUnique({
    where: {
      userId_monthYear: { userId, monthYear },
    },
    include: { user: { include: { employee: true } } },
  });
};

const getPayrollRecordsByMonth = async (monthYear) => {
  return await prismaPayroll.findMany({
    where: { monthYear },
    include: { user: { include: { employee: true } } },
  });
};

const updatePayrollRecord = async (id, data) => {
  return await prismaPayroll.update({
    where: { id },
    data,
    include: { user: { include: { employee: true } } },
  });
};

const upsertPayrollRecord = async (userId, monthYear, data) => {
  return await prismaPayroll.upsert({
    where: {
      userId_monthYear: { userId, monthYear },
    },
    update: data,
    create: {
      userId,
      monthYear,
      ...data,
    },
    include: { user: { include: { employee: true } } },
  });
};

module.exports = {
  createPayrollRecord,
  getPayrollRecordById,
  getPayrollRecordByUserAndMonth,
  getPayrollRecordsByMonth,
  updatePayrollRecord,
  upsertPayrollRecord,
};
