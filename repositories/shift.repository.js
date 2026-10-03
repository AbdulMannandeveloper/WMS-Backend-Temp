const { prisma } = require("../lib/prisma");

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

const getShiftByField = async (field, value) => {
  return await prismaShift.findMany({ where: { [field]: value } });
};

const getShiftFirstByField = async (field, value) => {
  return await prismaShift.findFirst({ where: { [field]: value } });
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
