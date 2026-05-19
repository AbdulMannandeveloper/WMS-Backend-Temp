const { prisma } = require("../lib/prisma");
const prismaInventoryLedger = prisma.inventoryLedger;

const inventoryLedgerRepository = async (data) => {
  return await prismaInventoryLedger.create({
    data,
  });
};

const getAllInventoryLedgers = async () => {
  return await prismaInventoryLedger.findMany();
};

const getInventoryLedgerByField = async (field, value) => {
  return await prismaInventoryLedger.findUnique({
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
  inventoryLedgerRepository,
  getAllInventoryLedgers,
  getInventoryLedgerByField,
//   updateInventoryLedger,
  deleteInventoryLedger,
};
