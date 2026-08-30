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

/**
 * Every agreed rate for one client — what the client portal shows.
 *
 * The controller has always called this name; it never existed, so
 * GET /api/client-services/client/:clientId failed with "is not a function"
 * for every caller since the route was written.
 */
const getClientServicesByClientId = async (clientId) => {
  return await clientServiceRepository.getClientServiceByField('clientId', clientId);
};

/** Every client who has an agreed rate for one service. Same story. */
const getClientServicesByServiceId = async (serviceId) => {
  return await clientServiceRepository.getClientServiceByField('serviceId', serviceId);
};

const getClientServiceByClientIdAndServiceId = async (clientId, serviceId) => {
  return await clientServiceRepository.getClientServiceByClientIdAndServiceId(
    clientId,
    serviceId,
  );
};

/**
 * Fields an admin may change on an agreed rate.
 *
 * Allowlisted rather than passed straight through: clientId and serviceId are
 * the pair the unique key is built from, and letting a body rewrite them would
 * move a rate onto a different client — silently repricing their invoices.
 *
 * isRecurring / recurringQuantity turn a rate into a standing monthly charge,
 * raised whether or not anything shipped. That is how a client who takes storage
 * or a retainer but never ships gets billed at all.
 */
const CLIENT_SERVICE_UPDATE_FIELDS = [
  'chargedPrice',
  'unit',
  'isRecurring',
  'recurringQuantity',
];

const updateClientService = async (id, rawUpdateData) => {
  const updateData = {};
  for (const field of CLIENT_SERVICE_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawUpdateData, field)) {
      updateData[field] = rawUpdateData[field];
    }
  }

  if (updateData.chargedPrice !== undefined && Number(updateData.chargedPrice) < 0) {
    throw new Error('A charged price cannot be negative.');
  }

  if (updateData.recurringQuantity !== undefined) {
    const quantity = Number(updateData.recurringQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Recurring quantity must be above zero.');
    }
  }

  // A standing charge with no quantity would bill nothing every month and look
  // like it was working.
  if (updateData.isRecurring === true && updateData.recurringQuantity === undefined) {
    const existing = await clientServiceRepository.getClientServiceByField('id', id);
    const current = Array.isArray(existing) ? existing[0] : existing;
    if (!current || Number(current.recurringQuantity ?? 0) <= 0) {
      updateData.recurringQuantity = 1;
    }
  }

  return await clientServiceRepository.updateClientService(id, updateData);
};

const deleteClientService = async (id) => {
  return await clientServiceRepository.deleteClientService(id);
};

module.exports = {
  addClientService,
  getAllClientServices,
  getClientServicesByField,
  getClientServicesByClientId,
  getClientServicesByServiceId,
  getClientServiceByClientIdAndServiceId,
  updateClientService,
  deleteClientService,
};
