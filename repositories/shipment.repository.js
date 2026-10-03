const { prisma } = require("../lib/prisma");
const { assertAllowedField } = require("../utils/pick");

const SHIPMENT_QUERY_FIELDS = [
  "id",
  "reference",
  "employeeId",
  "createdByUserId",
  "clientId",
  "status",
];

/**
 * A person, named — and nothing else.
 *
 * `user: true` returns every scalar on User, and one of them is
 * `passwordHash`. This include is what getShipmentsByClientId reads, so that
 * hash was reaching the client portal: an outside party, holding a staff
 * member's credential material, because a relation was included by default
 * rather than by choice.
 */
const userSummary = {
  select: { id: true, firstName: true, lastName: true, email: true },
};

const includeRelations = {
  client: true,
  // Who made the shipment. Added because nothing asked for it: Phase 20 started
  // recording the session user in createdByUserId and stopped setting
  // employeeId, but this include was never updated — so the API kept answering
  // with the old employee, and every shipment an admin made looked like it
  // belonged to somebody else or to nobody.
  createdBy: userSummary,
  employee: {
    include: {
      user: userSummary,
    },
  },
  shipmentItems: {
    include: {
      product: true,
      sourceLocation: true,
      // How much of returnedQuantity the Returns screen booked. The rest came
      // back through the line return button, which is undone from the
      // shipment itself (shipment.logic undoLineReturns).
      productReturns: { select: { quantity: true } },
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

/**
 * The highest references already issued in a series, newest first.
 *
 * References are generated rather than scanned now, so the next one is the last
 * one plus one. Ordering is lexicographic, which is the same as numeric only
 * because every sequence is zero-padded to a fixed width — see REFERENCE_DIGITS
 * in the logic. Reference is unique, so this rides its index.
 *
 * Several rows rather than one because the prefix can also match a reference
 * written before this scheme existed, and those sort above the generated ones
 * (a letter beats a digit). The caller takes the first that parses, so one
 * legacy row cannot send the sequence back to the start.
 */
const getLatestReferencesInSeries = async (prefix, take, tx) => {
  return await db(tx).shipment.findMany({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: "desc" },
    select: { reference: true },
    take,
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
  getLatestReferencesInSeries,
  updateShipment,
  deleteShipment,
};
