const { prisma } = require("../lib/prisma");

// db(tx) rather than a module-level `prisma.shipmentServiceMapping` const, so
// these reads and writes can join a caller's transaction. Dispatch needs that:
// it reads the mappings inside the same transaction that moves the stock and
// raises the invoice lines.
const db = (tx) => tx || prisma;

const includeRelations = {
  service: true,
  clientService: true,
};

const createShipmentServiceMapping = async (data, tx) => {
  return await db(tx).shipmentServiceMapping.create({
    data,
    include: includeRelations,
  });
};

const getAllShipmentServiceMappings = async (tx) => {
  return await db(tx).shipmentServiceMapping.findMany({
    include: includeRelations,
  });
};

const getShipmentServiceMappingByField = async (field, value, tx) => {
  return await db(tx).shipmentServiceMapping.findFirst({
    where: { [field]: value },
    include: includeRelations,
  });
};

// Returns ALL mappings matching the field — used by dispatchShipment to iterate services
const getShipmentServiceMappingsByField = async (field, value, tx) => {
  return await db(tx).shipmentServiceMapping.findMany({
    where: { [field]: value },
    include: includeRelations,
  });
};

const updateShipmentServiceMapping = async (id, data, tx) => {
  return await db(tx).shipmentServiceMapping.update({
    where: { id },
    data,
    include: includeRelations,
  });
};

const deleteShipmentServiceMapping = async (id, tx) => {
  return await db(tx).shipmentServiceMapping.delete({
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
