const { prisma } = require('../lib/prisma');
const { assertAllowedField } = require('../utils/pick');

const prismaClientService = prisma.clientService;

// A client's negotiated rates. Callers hardcode the field, but this is a
// per-client price book and a dynamic key is one query parameter away from
// being a way to read across clients.
const CLIENT_SERVICE_QUERY_FIELDS = ['id', 'clientId', 'serviceId'];

const createClientServiceEntry = async (clientServiceData) => {
  return await prismaClientService.create({ data: clientServiceData });
};

const getAllClientServices = async () => {
  return await prismaClientService.findMany();
};

const getClientServiceByField = async (field, value) => {
  assertAllowedField(field, CLIENT_SERVICE_QUERY_FIELDS);
  return await prismaClientService.findMany({
    where: {
      [field]: value,
    },
    // The service relation carries the description/unit, so callers can render a
    // client's assigned services without reading the full admin-only price book.
    include: { service: true },
  });
};

/**
 * The agreed rate for one service on one client, or null.
 *
 * findFirst, not findMany. This used to hand back an array, which is a quiet
 * trap: an empty array is truthy, so every `if (!clientService) throw` guard
 * downstream was dead code and the price was read off the array as undefined —
 * a shipment billed at nothing. The schema's @@unique(clientId, serviceId)
 * guarantees at most one row, so the singular name is the honest one.
 */
const getClientServiceByClientIdAndServiceId = async (clientId, serviceId) => {
  return await prismaClientService.findFirst({
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
