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

// Returns ALL mappings matching the field — used by dispatchShipment to iterate services
const getShipmentServiceMappingsByField = async (field, value) => {
  return await prismaShipmentServiceMapping.findMany({
    where: { [field]: value },
    include: {
      service: true,
    },
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
  getShipmentServiceMappingsByField,
  updateShipmentServiceMapping,
  deleteShipmentServiceMapping,
};
