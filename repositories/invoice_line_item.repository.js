const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const db = (tx) => tx || prisma;

// Line items carry no client column of their own — ownership is proven by
// re-reading the parent invoice. A dynamic key here would be the one place that
// check could be walked around, so it is pinned to the columns callers use.
const LINE_ITEM_QUERY_FIELDS = ["id", "invoiceId", "itemType", "clientServiceId"];

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
  assertAllowedField(field, LINE_ITEM_QUERY_FIELDS);
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
