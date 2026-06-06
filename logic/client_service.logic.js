const clientServiceRepository = require("../repositories/client_service.repository");
const clientRepository = require("../repositories/client.repository");
const serviceRepository = require("../repositories/service.repository");

const addClientService = async (clientServiceData) => {
  // Validate client existence
  const client = await clientRepository.getClientById(
    clientServiceData.clientId,
  );
  if (!client) {
    throw new Error(
      "Client not found. Cannot create client-service entry without a valid client.",
    );
  }

  // Validate service existence
  const service = await serviceRepository.getServiceById(
    clientServiceData.serviceId,
  );
  if (!service) {
    throw new Error(
      "Service not found. Cannot create client-service entry without a valid service.",
    );
  }

  if (!clientServiceData.chargedPrice) {
    clientServiceData.chargedPrice = service.ideaPrice; // Default to service idea price if not provided
  }

  if (!clientServiceData.unit) {
    clientServiceData.unit = service.unit; // Default to service unit if not provided
  }

  // Create the client-service entry
  return await clientServiceRepository.createClientServiceEntry(
    clientServiceData,
  );
};

const getAllClientServices = async () => {
  return await clientServiceRepository.getAllClientServices();
};

const getClientServicesByField = async (field, value) => {
  return await clientServiceRepository.getClientServiceByField(field, value);
};

const getClientServiceByClientIdAndServiceId = async (clientId, serviceId) => {
  return await clientServiceRepository.getClientServiceByClientIdAndServiceId(
    clientId,
    serviceId,
  );
};

const updateClientService = async (id, updateData) => {
  return await clientServiceRepository.updateClientService(id, updateData);
};

const deleteClientService = async (id) => {
  return await clientServiceRepository.deleteClientService(id);
};

module.exports = {
  addClientService,
  getAllClientServices,
  getClientServicesByField,
  getClientServiceByClientIdAndServiceId,
  updateClientService,
  deleteClientService,
};
