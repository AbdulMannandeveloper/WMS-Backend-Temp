const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const SHIPMENT_QUERY_FIELDS = [
  "id",
  "employeeId",
  "clientId",
  "status",
  "shipmentType",
  "courierName",
];

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
};

const db = (tx) => tx || prisma;

const createShipment = async (data, tx) => {
  return await db(tx).shipment.create({
    data,
    include: includeRelations,
  });
};

const getAllShipments = async (tx) => {
  return await db(tx).shipment.findMany({
    include: includeRelations,
  });
};

const getShipmentByField = async (field, value, tx) => {
  assertAllowedField(field, SHIPMENT_QUERY_FIELDS);
  return await db(tx).shipment.findFirst({
    where: { [field]: value },
    include: includeRelations,
  });
};

const getShipmentsByClientId = async (clientId, tx) => {
  return await db(tx).shipment.findMany({
    where: { clientId },
    include: includeRelations,
  });
};

const updateShipment = async (id, data, tx) => {
  return await db(tx).shipment.update({
    where: { id },
    data,
    include: includeRelations,
  });
};

const deleteShipment = async (id, tx) => {
  return await db(tx).shipment.delete({
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
