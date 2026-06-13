const { prisma } = require("../lib/prisma");

const prismaShipment = prisma.shipment;

const includeRelations = {
  client: true,
  employee: {
    include: {
      user: true,
    },
  },
  shipmentItems: {
    include: {
      product: true,
      sourceLocation: true,
    },
  },
  shipmentServices: {
    include: {
      service: true,
    },
  },
};

const createShipment = async (data) => {
  return await prismaShipment.create({
    data,
    include: includeRelations,
  });
};

const getAllShipments = async () => {
  return await prismaShipment.findMany({
    include: includeRelations,
  });
};

const getShipmentByField = async (field, value) => {
  return await prismaShipment.findFirst({
    where: { [field]: value },
    include: includeRelations,
  });
};

const getShipmentsByClientId = async (clientId) => {
  return await prismaShipment.findMany({
    where: { clientId },
    include: includeRelations,
  });
};

const updateShipment = async (id, data) => {
  return await prismaShipment.update({
    where: { id },
    data,
    include: includeRelations,
  });
};

const deleteShipment = async (id) => {
  return await prismaShipment.delete({
    where: { id },
  });
};

module.exports = {
  createShipment,
  getAllShipments,
  getShipmentByField,
  getShipmentsByClientId,
  updateShipment,
  deleteShipment,
};
