const { prisma } = require("../lib/prisma");

const prismaInvoiceLineItem = prisma.invoiceLineItem;

const createInvoiceLineItem = async (lineItemData) => {
  return await prismaInvoiceLineItem.create({
    data: lineItemData,
    include: {
      clientService: {
        include: { service: true },
      },
    },
  });
};

const getAllInvoiceLineItems = async () => {
  return await prismaInvoiceLineItem.findMany();
};

const getInvoiceLineItemsByField = async (field, value) => {
  return await prismaInvoiceLineItem.findMany({
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
  getInvoiceLineItemsByField,
  updateInvoiceLineItem,
  deleteInvoiceLineItem,
};
