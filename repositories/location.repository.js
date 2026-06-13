const warehouseLocationRepo = require('./warehouse_location.repository');

const getLocationByField = async (field, value) => {
  // Delegate to warehouse location repo and normalize result to a single record
  const results = await warehouseLocationRepo.getWarehouseLocationByField(field, value);
  if (!results) return null;
  // If findMany-style array returned, return first match
  if (Array.isArray(results)) return results.length > 0 ? results[0] : null;
  return results;
};

const getAllLocations = async () => {
  return await warehouseLocationRepo.getAllWarehouseLocations();
};

const createLocation = async (data) => {
  return await warehouseLocationRepo.createWarehouseLocation(data);
};

const updateLocation = async (id, updateData) => {
  return await warehouseLocationRepo.updateWarehouseLocation(id, updateData);
};

const deleteLocation = async (id) => {
  return await warehouseLocationRepo.deleteWarehouseLocation(id);
};

module.exports = {
  getLocationByField,
  getAllLocations,
  createLocation,
  updateLocation,
  deleteLocation,
};
