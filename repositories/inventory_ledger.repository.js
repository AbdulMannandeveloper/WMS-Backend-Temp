const { prisma } = require("../lib/prisma");
const prismaInventoryLedger = prisma.inventoryLedger;

const includeRelations = {
  product: {
    include: {
      client: {
        select: { id: true, companyName: true, contactName: true, email: true },
      },
    },
  },
  user: {
    select: { id: true, firstName: true, lastName: true, username: true, role: true },
  },
  fromLocation: {
    include: { locationClass: true },
  },
  toLocation: {
    include: { locationClass: true },
  },
};

const createInventoryLedger = async (data) => {
  return await prismaInventoryLedger.create({
    data,
    include: includeRelations,
  });
};

const getAllInventoryLedgers = async (filters = {}) => {
  return await prismaInventoryLedger.findMany({
    where: filters,
    include: includeRelations,
    orderBy: { timestamp: "desc" },
  });
};

const getInventoryLedgerByField = async (field, value) => {
  return await prismaInventoryLedger.findMany({
    where: { [field]: value },
    include: includeRelations,
    orderBy: { timestamp: "desc" },
  });
};

// ONLY FOR ROLLBACK PURPOSES - NOT EXPOSED TO API
const deleteInventoryLedger = async (id) => {
  return await prismaInventoryLedger.delete({
    where: { id },
  });
};

module.exports = {
  createInventoryLedger,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
//   updateInventoryLedger,
  deleteInventoryLedger,
};
