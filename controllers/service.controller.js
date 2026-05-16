const serviceLogic = require("../logic/service.logic");

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

const deleteService = async (req, res) => {
  try {
    await serviceLogic.deleteService(req.params.id);
    res.status(200).json({ message: "Service deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
};
