const { prisma } = require("../lib/prisma");
const { fieldMatch } = require("../utils/identifiers");

const prismaShift = prisma.shift;

const createShift = async (shiftData) => {
  return await prismaShift.create({ data: shiftData });
};

const getAllShifts = async () => {
  return await prismaShift.findMany();
};

const getShiftById = async (id, tx) => {
  return await (tx ? tx.shift : prismaShift).findUnique({ where: { id } });
};

const updateShift = async (id, updateData) => {
  return await prismaShift.update({ where: { id }, data: updateData });
};

const deleteShift = async (id, tx) => {
  return await (tx ? tx.shift : prismaShift).delete({ where: { id } });
};

// Names ignore case, so check-in still finds the default shift if someone
// saved it as "Default". The database keeps names unique ignoring case
// (migration 20261003150000), so there is only ever one to find.
const CASELESS_FIELDS = ["name"];

const getShiftByField = async (field, value) => {
  return await prismaShift.findMany({ where: fieldMatch(field, value, CASELESS_FIELDS) });
};

const getShiftFirstByField = async (field, value) => {
  return await prismaShift.findFirst({ where: fieldMatch(field, value, CASELESS_FIELDS) });
};

module.exports = {
  createShift,
  getAllShifts,
  getShiftById,
  getShiftByField,
  getShiftFirstByField,
  updateShift,
  deleteShift,
};
