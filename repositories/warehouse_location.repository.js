const { prisma } = require("../lib/prisma");

const prismaWarehouseLocation = prisma.warehouseLocation;

const createWarehouseLocation = async (locationData) => {
  return await prismaWarehouseLocation.create({
    data: locationData,
  });
};

const getAllWarehouseLocations = async () => {
  return await prismaWarehouseLocation.findMany({
    include: {
      locationClass: {
        include: {
          parentClass: true,
        },
      },
      parentLocation: true,
      childLocations: true,
    },
  });
};

const getWarehouseLocationByField = async (field, value) => {
  return await prismaWarehouseLocation.findMany({
    where: { [field]: value },
  });
};

const getWarehouseLocationFirstByField = async (field, value) => {
  return await prismaWarehouseLocation.findFirst({
    where: { [field]: value },
    include: {
      locationClass: {
        include: {
          parentClass: true,
        },
      },
      parentLocation: true,
      childLocations: true,
    },
  });
};

const getWarehouseLocationByParentAndName = async (
  parentLocationId,
  locationName,
  excludeId,
) => {
  return await prismaWarehouseLocation.findFirst({
    where: {
      parentLocationId,
      locationName,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
};

const updateWarehouseLocation = async (id, updateData) => {
  return await prismaWarehouseLocation.update({
    where: { id },
    data: updateData,
  });
};

const deleteWarehouseLocation = async (id) => {
  return await prismaWarehouseLocation.delete({
    where: { id },
  });
};

module.exports = {
  createWarehouseLocation,
  getAllWarehouseLocations,
  getWarehouseLocationByField,
  getWarehouseLocationFirstByField,
  getWarehouseLocationByParentAndName,
  updateWarehouseLocation,
  deleteWarehouseLocation,
};
