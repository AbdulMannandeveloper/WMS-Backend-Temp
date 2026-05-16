const { prisma } = require("../lib/prisma");

const prismaShift = prisma.shift;

const createShift = async (shiftData) => {
  return await prismaShift.create({ data: shiftData });
};

const getAllShifts = async () => {
  return await prismaShift.findMany();
};

const getShiftById = async (id) => {
  return await prismaShift.findUnique({ where: { id } });
};

const updateShift = async (id, updateData) => {
  return await prismaShift.update({ where: { id }, data: updateData });
};

const deleteShift = async (id) => {
  return await prismaShift.delete({ where: { id } });
};

module.exports = {
  createShift,
  getAllShifts,
  getShiftById,
  updateShift,
  deleteShift,
};
