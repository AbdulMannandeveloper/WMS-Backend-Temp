const serviceRepository = require('../repositories/service.repository');

const addNewService = async (serviceData) => {
	if (serviceData.ideaPrice < 0) {
	throw new Error("Service price cannot be negative");
	}

	return await serviceRepository.createServiceEntry(serviceData);
};

const getAllServices = async () => {
	return await serviceRepository.getAllServices();
};

module.exports = { addNewService, getAllServices };