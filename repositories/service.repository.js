const { prisma } = require('../lib/prisma');

const getAllServices = async () => {
  return await prisma.service.findMany();
};

const createServiceEntry = async (data) => {
  return await prisma.service.create({ data });
};

const getServiceById = async (id) => {
  return await prisma.service.findUnique({ where: { id } });
};

const updateService = async (id, data) => {
  return await prisma.service.update({ where: { id }, data });
};

const deleteService = async (id) => {
  return await prisma.service.delete({ where: { id } });
};

module.exports = {
  getAllServices,
  createServiceEntry,
  getServiceById,
  updateService,
  deleteService,
};
