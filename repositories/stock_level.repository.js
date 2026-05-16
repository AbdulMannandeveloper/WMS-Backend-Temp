const { prisma } = require('../lib/prisma');

const prismaStockLevel = prisma.stockLevel;

const createStockLevel = async (stockLevelData) => {
  return await prismaStockLevel.create({ data: stockLevelData });
};

const getAllStockLevels = async () => {
  return await prismaStockLevel.findMany();
};

const getStockLevelByField = async (field, value) => {
  return await prismaStockLevel.findMany({
    where: {
      [field]: value,
    },
  });
};

const updateStockLevel = async (id, updateData) => {
  return await prismaStockLevel.update({
    where: { id },
    data: updateData,
  });
};

const updateStockLevelByProductAndLocation = async ( productId, locationId, updateData ) => {
  return await prismaStockLevel.updateMany({
    where: {
      productId: productId,
      locationId: locationId,
    },
    data: updateData,
  });
};

const deleteStockLevel = async (id) => {
  return await prismaStockLevel.delete({
    where: { id },
  });
};

module.exports = {
  createStockLevel,
  getAllStockLevels,
  getStockLevelByField,
  updateStockLevel,
  updateStockLevelByProductAndLocation,
  deleteStockLevel,
};
