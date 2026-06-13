const { prisma } = require("../lib/prisma");
const prismaInventoryLedger = prisma.inventoryLedger;

const createInventoryLedger = async (data) => {
  return await prismaInventoryLedger.create({
    data,
  });
};

const getAllInventoryLedgers = async () => {
  return await prismaInventoryLedger.findMany();
};

const getInventoryLedgerByField = async (field, value) => {
  return await prismaInventoryLedger.findMany({
    where: { [field]: value },
  });
};

// const updateInventoryLedger = async (id, updateData) => {
//   return await prismaInventoryLedger.update({
//     where: { id },
//     data: updateData,
//   });
// };

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
