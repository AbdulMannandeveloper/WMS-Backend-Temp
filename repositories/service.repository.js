const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getAllServices = async () => {
  return await prisma.service.findMany();
};

const createServiceEntry = async (data) => {
  return await prisma.service.create({ data });
};

module.exports = { getAllServices, createServiceEntry };