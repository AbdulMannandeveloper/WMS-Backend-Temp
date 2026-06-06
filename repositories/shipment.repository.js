const { prisma } = require("../lib/prisma");

const prismaShipment = prisma.shipment;

const createShipment = async (data) => {
  return await prismaShipment.create({ data });
};

const getAllShipments = async () => {
  return await prismaShipment.findMany();
};

const getShipmentByField = async (field, value) => {
  return await prismaShipment.findFirst({
    where: { [field]: value },
  });
};

const getShipmentsByClientId = async (clientId) => {
  return await prismaShipment.findMany({
    where: { clientId },
  });
};

const updateShipment = async (id, data) => {
  return await prismaShipment.update({
    where: { id },
    data,
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
