const { prisma } = require("../lib/prisma");

const prismaHoliday = prisma.holiday;

const createHoliday = async (holidayData) => {
  return await prismaHoliday.create({ data: holidayData });
};

const getAllHolidays = async () => {
  return await prismaHoliday.findMany();
};

const getHolidayById = async (id) => {
  return await prismaHoliday.findUnique({ where: { id } });
};

const updateHoliday = async (id, updateData) => {
  return await prismaHoliday.update({ where: { id }, data: updateData });
};

const deleteHoliday = async (id) => {
  return await prismaHoliday.delete({ where: { id } });
};

module.exports = {
  createHoliday,
  getAllHolidays,
  getHolidayById,
  updateHoliday,
  deleteHoliday,
};
