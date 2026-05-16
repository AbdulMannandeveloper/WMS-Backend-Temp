const serviceRepository = require("../repositories/service.repository");

const addNewService = async (serviceData) => {
  if (serviceData.ideaPrice < 0) {
    throw new Error("Service price cannot be negative");
  }

  return await serviceRepository.createServiceEntry(serviceData);
};

const getAllServices = async () => {
  return await serviceRepository.getAllServices();
};

const getServiceById = async (id) => {
  return await serviceRepository.getServiceById(id);
};

const updateService = async (id, serviceData) => {
  if (serviceData.ideaPrice < 0) {
    throw new Error("Service price cannot be negative");
  }

  return await serviceRepository.updateService(id, serviceData);
};

const deleteService = async (id) => {
  return await serviceRepository.deleteService(id);
};

module.exports = {
  addNewService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
};
