const { prisma } = require("../lib/prisma");

const prismaMonthlyInvoice = prisma.monthlyInvoice;

const createMonthlyInvoice = async (invoiceData) => {
  return await prismaMonthlyInvoice.create({ data: invoiceData });
};

const getMonthlyInvoiceByClientIdAndMonth = async (clientId, billingMonth) => {
  return await prismaMonthlyInvoice.findUnique({
    where: {
      clientId: clientId,
      billingPeriod: billingMonth,
    },
  });
};

const getMonthlyInvoiceById = async (id) => {
  return await prismaMonthlyInvoice.findUnique({
    where: { id },
  });
};

const getMonthlyInvoiceByField = async (field, value) => {
  return await prismaMonthlyInvoice.findMany({
    where: {
      [field]: value,
    },
  });
};

const updateMonthlyInvoice = async (id, updateData) => {
  return await prismaMonthlyInvoice.update({
    where: { id },
    data: updateData,
  });
};

const deleteMonthlyInvoice = async (id) => {
  return await prismaMonthlyInvoice.delete({
    where: { id },
  });
};

module.exports = {
  createMonthlyInvoice,
  getMonthlyInvoiceByClientIdAndMonth,
  getMonthlyInvoiceById,
  getMonthlyInvoiceByField,
  updateMonthlyInvoice,
  deleteMonthlyInvoice,
};
