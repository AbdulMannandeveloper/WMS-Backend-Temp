const { prisma } = require('../lib/prisma');

const prismaClientService = prisma.clientService;

const createClientServiceEntry = async (clientServiceData) => {
  return await prismaClientService.create({ data: clientServiceData });
};

const getAllClientServices = async () => {
  return await prismaClientService.findMany();
};

const getClientServiceByField = async (field, value) => {
  return await prismaClientService.findMany({
    where: {
      [field]: value,
    },
  });
};

const getClientServiceByClientIdAndServiceId = async (clientId, serviceId) => {
  return await prismaClientService.findMany({
    where: {
      clientId: clientId,
      serviceId: serviceId,
    },
  });
};

const updateClientService = async (id, updateData) => {
  return await prismaClientService.update({
    where: { id },
    data: updateData,
  });
};

const deleteClientService = async (id) => {
  return await prismaClientService.delete({
    where: { id },
  });
};

module.exports = {
  createClientServiceEntry,
  getAllClientServices,
  getClientServiceByField,
  getClientServiceByClientIdAndServiceId,
  updateClientService,
  deleteClientService,
};
