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

const getStockLevelByProductAndLocation = async (productId, locationId) => {
  return await prismaStockLevel.findUnique({
    where: {
      productId: productId,
      locationId: locationId,
    },
  });
};

const updateStockLevel = async (id, updateData) => {
  return await prismaStockLevel.update({
    where: { id },
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
  getStockLevelByProductAndLocation,
  updateStockLevel,
  deleteStockLevel,
};
