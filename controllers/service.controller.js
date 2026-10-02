const serviceLogic = require("../logic/service.logic");
const { dependentsBody } = require("../utils/dependents");

const createService = async (req, res) => {
  try {
    const result = await serviceLogic.addNewService(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getAllServices = async (req, res) => {
  try {
    const services = await serviceLogic.getAllServices();
    if (services.length === 0) {
      return res.status(404).json({ message: "No services found" });
    }
    res.status(200).json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getServiceById = async (req, res) => {
  try {
    const service = await serviceLogic.getServiceById(req.params.id);
    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }
    res.status(200).json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateService = async (req, res) => {
  try {
    const updatedService = await serviceLogic.updateService(
      req.params.id,
      req.body,
    );
    res.status(200).json(updatedService);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// What would stop a delete, asked before the admin presses it.
const getServiceDependents = async (req, res) => {
  try {
    const { report } = await serviceLogic.getServiceDependents(req.params.id);
    res.status(200).json(report);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

const deleteService = async (req, res) => {
  try {
    await serviceLogic.deleteService(req.params.id, req.user.id);
    res.status(200).json({ message: "Service deleted successfully" });
  } catch (err) {
    // Was a 500 for every refusal, including the foreign key a service still
    // on a shipment trips — so "in use" read as "the server broke".
    if (err.code === "HAS_DEPENDENTS") {
      return res.status(409).json(dependentsBody(err));
    }
    res.status(err.status || 400).json({ error: err.message });
  }
};

module.exports = {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  getServiceDependents,
  deleteService,
};
