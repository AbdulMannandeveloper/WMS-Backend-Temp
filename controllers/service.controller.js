const serviceLogic = require('../logic/service.logic');

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
            return res.status(404).json({ message: 'No services found' });
        }
        res.status(200).json(services);
    } catch (err) {
        res.status(500).json({ error: err.message    });
    }
};

module.exports = { createService, getAllServices };