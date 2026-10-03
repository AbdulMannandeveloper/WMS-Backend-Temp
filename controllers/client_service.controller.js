const clientServiceLogic = require("../logic/client_service.logic");
const { canAccessClientId } = require("../utils/clientScope");
const { paginatedResponse } = require("../utils/pagination");
const { buildListQuery } = require("../utils/queryFilters");
const { listError } = require("../utils/listResponse");

const createClientServiceEntry = async (req, res) => {
  try {
    const clientServiceData = req.body;
    const clientService =
      await clientServiceLogic.addClientService(clientServiceData, req.user.id);
    res.status(201).json(clientService);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllClientServices = async (req, res) => {
  try {
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      clientServiceLogic.CLIENT_SERVICE_LIST_SPEC,
    );

    const result = await clientServiceLogic.getAllClientServices(where, {
      orderBy,
      pagination,
    });

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (error) {
    return listError(res, error, "getAllClientServices");
  }
};

/** How many rates, across how many clients and services. */
const getClientServiceSummary = async (req, res) => {
  try {
    const { where } = buildListQuery(
      req.query,
      clientServiceLogic.CLIENT_SERVICE_LIST_SPEC,
    );
    return res
      .status(200)
      .json(await clientServiceLogic.summariseClientServices(where));
  } catch (error) {
    return listError(res, error, "getClientServiceSummary");
  }
};

const getClientServicesByClientId = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A client may only read their own assigned services. Staff may read any.
    if (!(await canAccessClientId(req.user, clientId))) {
      return res.status(403).json({ error: "You do not have access to this client's records." });
    }

    const clientServices =
      await clientServiceLogic.getClientServicesByClientId(clientId);
    res.status(200).json(clientServices);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
};

const getClientServicesByServiceId = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const clientServices =
      await clientServiceLogic.getClientServicesByServiceId(serviceId);
    res.status(200).json(clientServices);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
};

const updateClientService = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const clientService = await clientServiceLogic.updateClientService(
      id,
      updateData,
      req.user.id,
    );
    res.status(200).json(clientService);
  } catch (error) {
    // A rejected price or quantity is a bad request, not a missing record. It
    // was returning 404 for both, so a validation message arrived looking like
    // the rate had vanished.
    const missing =
      /not found/i.test(error.message) ||
      error.code === 'P2025'; // Prisma: record to update does not exist
    res.status(missing ? 404 : 400).json({ error: error.message });
  }
};

const deleteClientService = async (req, res) => {
  try {
    const { id } = req.params;
    await clientServiceLogic.deleteClientService(id, req.user.id);
    res
      .status(200)
      .json({ message: "Client-service entry deleted successfully." });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
};

module.exports = {
  getClientServiceSummary,
  createClientServiceEntry,
  getAllClientServices,
  getClientServicesByClientId,
  getClientServicesByServiceId,
  updateClientService,
  deleteClientService,
};
