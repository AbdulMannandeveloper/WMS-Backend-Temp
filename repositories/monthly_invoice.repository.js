const { prisma } = require("../lib/prisma");

const prismaMonthlyInvoice = prisma.monthlyInvoice;

const includeRelations = {
  client: {
    select: {
      id: true,
      companyName: true,
      contactName: true,
      email: true,
    },
  },
  lineItems: {
    include: {
      clientService: {
        include: { service: true },
      },
    },
    orderBy: { dateOfService: "desc" },
  },
};

const createMonthlyInvoice = async (invoiceData) => {
  return await prismaMonthlyInvoice.create({ data: invoiceData });
};

const getAllMonthlyInvoices = async () => {
  return await prismaMonthlyInvoice.findMany({
    include: includeRelations,
    orderBy: { billingPeriod: "desc" },
  });
};

const getMonthlyInvoiceByClientIdAndMonth = async (clientId, billingMonth) => {
  return await prismaMonthlyInvoice.findUnique({
    where: {
      clientId_billingPeriod: {
        clientId: clientId,
        billingPeriod: billingMonth,
      },
    },
    include: includeRelations,
  });
};

const getMonthlyInvoiceById = async (id) => {
  return await prismaMonthlyInvoice.findUnique({
    where: { id },
    include: includeRelations,
  });
};

const getMonthlyInvoiceByField = async (field, value) => {
  return await prismaMonthlyInvoice.findMany({
    where: {
      [field]: value,
    },
    include: includeRelations,
    orderBy: { billingPeriod: "desc" },
  });
};

const updateMonthlyInvoice = async (id, updateData) => {
  return await prismaMonthlyInvoice.update({
    where: { id },
    data: updateData,
    include: includeRelations,
  });
};

const deleteMonthlyInvoice = async (id) => {
  return await prismaMonthlyInvoice.delete({
    where: { id },
  });
};

module.exports = {
  createMonthlyInvoice,
  getAllMonthlyInvoices,
  getMonthlyInvoiceByClientIdAndMonth,
  getMonthlyInvoiceById,
  getMonthlyInvoiceByField,
  updateMonthlyInvoice,
  deleteMonthlyInvoice,
};
