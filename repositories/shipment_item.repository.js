const { prisma } = require('../lib/prisma');

const db = (tx) => tx || prisma;

const createShipmentItem = async (data, tx) => {
  return await db(tx).shipmentItem.create({ data });
};

const getShipmentItemsByField = async (field, value, tx) => {
  return await db(tx).shipmentItem.findMany({
    where: { [field]: value },
  });
};

const updateShipmentItem = async (id, data, tx) => {
  return await db(tx).shipmentItem.update({
    where: { id },
    data,
  });
};

const deleteShipmentItem = async (id, tx) => {
  return await db(tx).shipmentItem.delete({
    where: { id },
  });
};

module.exports = {
  createShipmentItem,
  getShipmentItemsByField,
  updateShipmentItem,
  deleteShipmentItem,
};
