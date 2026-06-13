const { prisma } = require('../lib/prisma');

const prismaStockLevel = prisma.stockLevel;

const createStockLevel = async (stockLevelData) => {
  return await prismaStockLevel.create({
    data: stockLevelData,
    include: {
      product: {
        include: {
          client: true,
        },
      },
      location: {
        include: {
          locationClass: true,
        },
      },
    },
  });
};

const getAllStockLevels = async () => {
  return await prismaStockLevel.findMany({
    include: {
      product: {
        include: {
          client: true,
        },
      },
      location: {
        include: {
          locationClass: true,
        },
      },
    },
  });
};

const getStockLevelByField = async (field, value) => {
  return await prismaStockLevel.findMany({
    where: {
      [field]: value,
    },
    include: {
      product: {
        include: {
          client: true,
        },
      },
      location: {
        include: {
          locationClass: true,
        },
      },
    },
  });
};

const getStockLevelByProductAndLocation = async (productId, locationId) => {
  return await prismaStockLevel.findUnique({
    where: {
      productId_locationId: {
        productId: productId,
        locationId: locationId,
      },
    },
    include: {
      product: {
        include: {
          client: true,
        },
      },
      location: {
        include: {
          locationClass: true,
        },
      },
    },
  });
};

const getStockLevelById = async (id) => {
  return await prismaStockLevel.findUnique({
    where: { id },
    include: {
      product: {
        include: {
          client: true,
        },
      },
      location: {
        include: {
          locationClass: true,
        },
      },
    },
  });
};

const updateStockLevel = async (id, updateData) => {
  return await prismaStockLevel.update({
    where: { id },
    data: updateData,
    include: {
      product: {
        include: {
          client: true,
        },
      },
      location: {
        include: {
          locationClass: true,
        },
      },
    },
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
  getStockLevelById,
  getStockLevelByField,
  getStockLevelByProductAndLocation,
  updateStockLevel,
  deleteStockLevel,
};
