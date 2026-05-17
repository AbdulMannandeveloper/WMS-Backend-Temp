const { prisma } = require("../lib/prisma");

const prismaWarehouseLocation = prisma.warehouseLocation;

const createWarehouseLocation = async (locationData) => {
  return await prismaWarehouseLocation.create({
    data: locationData,
  });
};

const getAllWarehouseLocations = async () => {
  return await prismaWarehouseLocation.findMany();
};

const getWarehouseLocationByField = async (field, value) => {
  return await prismaWarehouseLocation.findMany({
    where: { [field]: value },
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
  updateWarehouseLocation,
  deleteWarehouseLocation,
};
