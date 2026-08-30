const clientServiceLogic = require("../logic/client_service.logic");
const { canAccessClientId } = require("../utils/clientScope");

const createClientServiceEntry = async (req, res) => {
  try {
    const clientServiceData = req.body;
    const clientService =
      await clientServiceLogic.addClientService(clientServiceData);
    res.status(201).json(clientService);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllClientServices = async (req, res) => {
  try {
    const clientServices = await clientServiceLogic.getAllClientServices();
    res.status(200).json(clientServices);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    await clientServiceLogic.deleteClientService(id);
    res
      .status(200)
      .json({ message: "Client-service entry deleted successfully." });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
};

module.exports = {
  createClientServiceEntry,
  getAllClientServices,
  getClientServicesByClientId,
  getClientServicesByServiceId,
  updateClientService,
  deleteClientService,
};
