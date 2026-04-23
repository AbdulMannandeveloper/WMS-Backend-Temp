const serviceRepo = require('../repositories/service.repository');

const addNewService = async (serviceData) => {
  if (serviceData.ideaPrice < 0) {
    throw new Error("Service price cannot be negative");
  }

  return await serviceRepo.createServiceEntry(serviceData);
};

const getAllServices = async () => {
  return await serviceRepo.getAllServices();
};

module.exports = { addNewService, getAllServices };