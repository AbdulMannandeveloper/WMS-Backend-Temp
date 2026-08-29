const shipmentServiceMappingRepositry = require("../repositories/shipment_service_mapping.repository");

// Deliberately the repository, not ./shipment.logic. shipment.logic requires
// this module, so requiring it back would recreate the circular import that
// broke shipment creation before chunk 1.2 — Node hands the second module a
// partially-initialised exports object and the reference never fills in.
const shipmentRepository = require("../repositories/shipment.repository");
const clientServiceRepository = require("../repositories/client_service.repository");

/**
 * Attaches a billable service to a shipment.
 *
 * The price is read from the client's negotiated ClientService rate and frozen
 * onto the mapping. Dispatch bills from that frozen figure, so changing a rate
 * afterwards never rewrites what a client was already charged.
 */
const createShipmentServiceMapping = async (data, tx) => {
  if (!data.shipmentId || !data.serviceId || !data.quantity) {
    throw new Error(
      "Shipment ID, Service ID, and Quantity are required to create a mapping.",
    );
  }

  if (Number(data.quantity) <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

  const shipment = await shipmentRepository.getShipmentByField(
    "id",
    data.shipmentId,
    tx,
  );
  if (!shipment) {
    throw new Error("Shipment not found.");
  }

  // That repository call is a findMany, so it hands back an array. Normalising
  // here rather than changing it, because an empty array is truthy: the original
  // `if (!clientService) throw` never fired, and appliedUnitPrice was silently
  // read off the array as undefined. The schema's unique(clientId, serviceId)
  // means there is at most one row.
  //
  // Read outside `tx` deliberately — an agreed rate is reference data set up long
  // before this transaction, not something it mutates.
  const matches =
    await clientServiceRepository.getClientServiceByClientIdAndServiceId(
      shipment.clientId,
      data.serviceId,
    );
  const clientService = Array.isArray(matches) ? matches[0] : matches;

  if (!clientService) {
    throw new Error(
      "That service is not set up for this client. Agree a rate on the client's services first.",
    );

    // ----------------------------------------------------------
    // We could fall back to the service's default ideaPrice here, but billing a
    // client a rate they never agreed is a commercial decision, not a technical
    // one. Left for chunk 2.1.
    // ----------------------------------------------------------
  }

  return await shipmentServiceMappingRepositry.createShipmentServiceMapping(
    {
      shipmentId: data.shipmentId,
      serviceId: data.serviceId,
      clientServiceId: clientService.id,
      quantity: data.quantity,
      appliedUnitPrice: clientService.chargedPrice,
    },
    tx,
  );
};

const getShipmentServiceMappingsByField = async (field, value, tx) => {
  return await shipmentServiceMappingRepositry.getShipmentServiceMappingsByField(
    field,
    value,
    tx,
  );
};

const getShipmentServiceMappingById = async (id, tx) => {
  return await shipmentServiceMappingRepositry.getShipmentServiceMappingByField(
    "id",
    id,
    tx,
  );
};

const updateShipmentServiceMapping = async (id, updateData, tx) => {
  const existing =
    await shipmentServiceMappingRepositry.getShipmentServiceMappingByField(
      "id",
      id,
      tx,
    );
  if (!existing) {
    throw new Error("Shipment service mapping not found.");
  }

  // The applied price is frozen at attachment time and is not editable. Detach
  // and reattach to pick up a new rate.
  if (updateData.appliedUnitPrice !== undefined) {
    throw new Error(
      "The applied unit price is fixed when the service is attached. Remove the service and add it again to pick up a new rate.",
    );
  }

  if (updateData.quantity !== undefined && Number(updateData.quantity) <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

  return await shipmentServiceMappingRepositry.updateShipmentServiceMapping(
    id,
    updateData,
    tx,
  );
};

const deleteShipmentServiceMapping = async (id, tx) => {
  return await shipmentServiceMappingRepositry.deleteShipmentServiceMapping(
    id,
    tx,
  );
};

module.exports = {
  createShipmentServiceMapping,
  getShipmentServiceMappingsByField,
  getShipmentServiceMappingById,
  updateShipmentServiceMapping,
  deleteShipmentServiceMapping,
};
