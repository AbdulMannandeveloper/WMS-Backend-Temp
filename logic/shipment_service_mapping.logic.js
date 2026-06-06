const shipmentServiceMappingRepositry = require("../repositories/shipment_service_mapping.repository");

const shipmentLogic = require("./shipment.logic");
const clientLogic = require("./client.logic");
const serviceLogic = require("./service.logic");
const clientServiceLogic = require("./client_service.logic");

const createShipmentServiceMapping = async (data) => {
  // Check for required fields
  if (!data.shipmentId || !data.serviceId || !data.quantity) {
    throw new Error(
      "Shipment ID, Service ID, and Quantity are required to create a mapping.",
    );
  }

  // Validate shipmentId and serviceId
  const shipment = await shipmentLogic.getShipmentByField(
    "id",
    data.shipmentId,
  );
  const clientService =
    await clientServiceLogic.getClientServiceByClientIdAndServiceId(
      shipment.clientId,
      data.serviceId,
    );

  if (!shipment) {
    throw new Error("Shipment not found.");
  }
  if (!clientService) {
    throw new Error("Client Service not found.");

    // ----------------------------------------------------------
    // We can also apply the idea/default price if the service exists but is 
    // not associated with the client, but for now we will just throw an error.
    
    
    // const service = await serviceLogic.getServiceByField("id", data.serviceId);
    // if (!service) {
    //   throw new Error("Service not found.");
    // }
    // data.appliedUnitPrice = service.ideaPrice;
    // ----------------------------------------------------------
  }

  data.appliedUnitPrice = clientService.chargedPrice;

  return await shipmentServiceMappingRepositry.createShipmentServiceMapping(
    data,
  );
};

const getShipmentServiceMappingsByField = async (field, value) => {
  return await shipmentServiceMappingRepositry.getShipmentServiceMappingsByField(
    field,
    value,
  );
};

const updateShipmentServiceMapping = async (id, updateData) => {
  if (updateData.shipmentId) {
    const shipment = await shipmentLogic.getShipmentByField(
      "id",
      updateData.shipmentId,
    );
    if (!shipment) {
      throw new Error("Shipment not found.");
    }
  }
  if (updateData.serviceId) {
    const clientService =
      await clientServiceLogic.getClientServiceByClientIdAndServiceId(
        shipment.clientId,
        updateData.serviceId,
      );
    if (!clientService) {
      throw new Error("Client Service not found.");
    }

    updateData.appliedUnitPrice = clientService.chargedPrice;
  }
  return await shipmentServiceMappingRepositry.updateShipmentServiceMapping(
    id,
    updateData,
  );
};

const deleteShipmentServiceMapping = async (id) => {
  return await shipmentServiceMappingRepositry.deleteShipmentServiceMapping(id);
};

module.exports = {
  createShipmentServiceMapping,
  getShipmentServiceMappingsByField,
  updateShipmentServiceMapping,
  deleteShipmentServiceMapping,
};
