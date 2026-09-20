const clientServiceRepository = require("../repositories/client_service.repository");
const {
  parseString,
  parseUuid,
  rangeFilter,
  searchFilter,
} = require("../utils/queryFilters");
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

/**
 * What the rate card may be narrowed by.
 *
 * Shared with the /summary handler. Note there is no clientId scoping here:
 * this list is admin-only, and a client reads its own rates through
 * /client/:clientId, which checks ownership of the path parameter. If this
 * route is ever opened to the client role, clientId has to move to
 * resolveClientFilter first.
 */
const CLIENT_SERVICE_LIST_SPEC = {
  filters: [
    (q) => searchFilter(q.search, [
      "client.companyName",
      "client.contactName",
      "service.description",
    ]),
    (q) => {
      const clientId = parseUuid(q.clientId, "clientId");
      return clientId ? { clientId } : undefined;
    },
    (q) => {
      const serviceId = parseUuid(q.serviceId, "serviceId");
      return serviceId ? { serviceId } : undefined;
    },
    (q) => {
      const unit = parseString(q.unit, { label: "unit", maxLength: 30 });
      return unit ? { unit } : undefined;
    },
    (q) => {
      const range = rangeFilter(q.priceMin, q.priceMax, { label: "price" });
      return range ? { chargedPrice: range } : undefined;
    },
  ],
  sort: {
    allowed: {
      // Two keys, because one client holds many rates: ordering by company
      // alone leaves every row within a client tied, and the id tiebreaker
      // then decides — deterministic, but a rate card in uuid order.
      clientName: (order) => [
        { client: { companyName: order } },
        { service: { description: order } },
      ],
      serviceDescription: (order) => ({ service: { description: order } }),
      chargedPrice: (order) => ({ chargedPrice: order }),
      unit: (order) => ({ unit: order }),
    },
    defaultSort: { field: "clientName", order: "asc" },
    tiebreaker: [{ id: "asc" }],
  },
};

const getAllClientServices = async (where, options) =>
  await clientServiceRepository.getAllClientServices(where, options);

const summariseClientServices = async (where) =>
  await clientServiceRepository.summariseClientServices(where);

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

 */
const CLIENT_SERVICE_UPDATE_FIELDS = [
  'chargedPrice',
  'unit',
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

  return await clientServiceRepository.updateClientService(id, updateData);
};

const deleteClientService = async (id) => {
  return await clientServiceRepository.deleteClientService(id);
};

module.exports = {
  CLIENT_SERVICE_LIST_SPEC,
  summariseClientServices,
  addClientService,
  getAllClientServices,
  getClientServicesByField,
  getClientServicesByClientId,
  getClientServicesByServiceId,
  getClientServiceByClientIdAndServiceId,
  updateClientService,
  deleteClientService,
};
