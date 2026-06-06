const { prisma } = require("../lib/prisma");

const prismaInvoiceLineItem = prisma.invoiceLineItem;

const createInvoiceLineItem = async (lineItemData) => {
  return await prismaInvoiceLineItem.create({ data: lineItemData });
};

const getAllInvoiceLineItems = async () => {
  return await prismaInvoiceLineItem.findMany();
};

const getInvoiceLineItemByField = async (field, value) => {
  return await prismaInvoiceLineItem.findMany({
    where: {
      [field]: value,
    },
  });
};

const updateInvoiceLineItem = async (id, updateData) => {
  return await prismaInvoiceLineItem.update({
    where: { id },
    data: updateData,
  });
};

const deleteInvoiceLineItem = async (id) => {
  return await prismaInvoiceLineItem.delete({
    where: { id },
  });
};

module.exports = {
  createInvoiceLineItem,
  getAllInvoiceLineItems,
  getInvoiceLineItemByField,
  updateInvoiceLineItem,
  deleteInvoiceLineItem,
};
