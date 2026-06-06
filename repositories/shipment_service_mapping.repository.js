const { prisma } = require("../lib/prisma");

const prismaShipmentServiceMapping = prisma.shipmentServiceMapping;

const createShipmentServiceMapping = async (data) => {
  return await prismaShipmentServiceMapping.create({ data });
};

const getAllShipmentServiceMappings = async () => {
  return await prismaShipmentServiceMapping.findMany();
};

const getShipmentServiceMappingByField = async (field, value) => {
  return await prismaShipmentServiceMapping.findFirst({
    where: { [field]: value },
  });
};

const updateShipmentServiceMapping = async (id, data) => {
  return await prismaShipmentServiceMapping.update({
    where: { id },
    data,
  });
};

const deleteShipmentServiceMapping = async (id) => {
  return await prismaShipmentServiceMapping.delete({
    where: { id },
  });
};

module.exports = {
  createShipmentServiceMapping,
  getAllShipmentServiceMappings,
  getShipmentServiceMappingByField,
  updateShipmentServiceMapping,
  deleteShipmentServiceMapping,
};
