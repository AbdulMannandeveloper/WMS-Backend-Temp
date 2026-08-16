const { prisma } = require("../lib/prisma");

const db = (tx) => tx || prisma;

const createInvoiceLineItem = async (lineItemData, tx) => {
  return await db(tx).invoiceLineItem.create({
    data: lineItemData,
    include: {
      clientService: {
        include: { service: true },
      },
    },
  });
};

const getAllInvoiceLineItems = async (tx) => {
  return await db(tx).invoiceLineItem.findMany();
};

const getInvoiceLineItemsByField = async (field, value, tx) => {
  return await db(tx).invoiceLineItem.findMany({
    where: {
      [field]: value,
    },
    include: {
      clientService: {
        include: { service: true },
      },
    },
    orderBy: { dateOfService: "desc" },
  });
};

const updateInvoiceLineItem = async (id, updateData, tx) => {
  return await db(tx).invoiceLineItem.update({
    where: { id },
    data: updateData,
  });
};

const deleteInvoiceLineItem = async (id, tx) => {
  return await db(tx).invoiceLineItem.delete({
    where: { id },
  });
};

module.exports = {
  createInvoiceLineItem,
  getAllInvoiceLineItems,
  getInvoiceLineItemsByField,
  updateInvoiceLineItem,
  deleteInvoiceLineItem,
};
