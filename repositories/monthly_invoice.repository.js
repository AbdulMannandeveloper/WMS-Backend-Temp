const { prisma } = require("../lib/prisma");

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

const db = (tx) => tx || prisma;

const createMonthlyInvoice = async (invoiceData, tx) => {
  return await db(tx).monthlyInvoice.create({ data: invoiceData });
};

const getAllMonthlyInvoices = async (tx) => {
  return await db(tx).monthlyInvoice.findMany({
    include: includeRelations,
    orderBy: { billingPeriod: "desc" },
  });
};

const getMonthlyInvoiceByClientIdAndMonth = async (clientId, billingMonth, tx) => {
  return await db(tx).monthlyInvoice.findUnique({
    where: {
      clientId_billingPeriod: {
        clientId: clientId,
        billingPeriod: billingMonth,
      },
    },
    include: includeRelations,
  });
};

const getMonthlyInvoiceById = async (id, tx) => {
  return await db(tx).monthlyInvoice.findUnique({
    where: { id },
    include: includeRelations,
  });
};

const getMonthlyInvoiceByField = async (field, value, tx) => {
  return await db(tx).monthlyInvoice.findMany({
    where: {
      [field]: value,
    },
    include: includeRelations,
    orderBy: { billingPeriod: "desc" },
  });
};

const updateMonthlyInvoice = async (id, updateData, tx) => {
  return await db(tx).monthlyInvoice.update({
    where: { id },
    data: updateData,
    include: includeRelations,
  });
};

const deleteMonthlyInvoice = async (id, tx) => {
  return await db(tx).monthlyInvoice.delete({
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
