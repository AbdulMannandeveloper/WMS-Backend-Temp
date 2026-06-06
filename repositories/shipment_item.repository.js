const { prisma } = require('../lib/prisma');

const prismaShipmentItem = prisma.shipmentItem;

const createShipmentItem = async (data) => {
  return await prismaShipmentItem.create({ data });
};

const getShipmentItemsByField = async (field, value) => {
  return await prismaShipmentItem.findMany({
    where: { [field]: value },
  });
};

const updateShipmentItem = async (id, data) => {
  return await prismaShipmentItem.update({
    where: { id },
    data,
  });
};

const deleteShipmentItem = async (id) => {
  return await prismaShipmentItem.delete({
    where: { id },
  });
};

module.exports = {
  createShipmentItem,
  getShipmentItemsByField,
  updateShipmentItem,
  deleteShipmentItem,
};