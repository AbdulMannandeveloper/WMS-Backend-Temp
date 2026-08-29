const shipmentServiceMappingLogic = require("../logic/shipment_service_mapping.logic");
const shipmentLogic = require("../logic/shipment.logic");
const auditLogLogic = require("../logic/audit_log.logic");

/**
 * Billable services attached to a shipment.
 *
 * Editable only while the shipment is PENDING: once it is ready or gone, the
 * charges are settled and changing them here would desync the shipment from the
 * invoice lines dispatch has already raised.
 */
const assertShipmentIsOpen = async (shipmentId) => {
  const shipment = await shipmentLogic.getShipmentByField("id", shipmentId);
  if (!shipment) {
    throw new Error("Shipment not found.");
  }
  if (shipment.status !== "PENDING") {
    throw new Error(
      `Services can only be changed while the shipment is PENDING — this one is ${shipment.status}.`,
    );
  }
  return shipment;
};

const listShipmentServices = async (req, res) => {
  try {
    const services =
      await shipmentServiceMappingLogic.getShipmentServiceMappingsByField(
        "shipmentId",
        req.params.id,
      );
    res.status(200).json(services);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const addShipmentService = async (req, res) => {
  try {
    await assertShipmentIsOpen(req.params.id);

    const mapping =
      await shipmentServiceMappingLogic.createShipmentServiceMapping({
        shipmentId: req.params.id,
        serviceId: req.body.serviceId,
        quantity: req.body.quantity,
      });

    await auditLogLogic
      .createAuditLog(req.user.id, "SHIPMENT_SERVICE_ADDED", {
        shipmentId: req.params.id,
        serviceId: mapping.serviceId,
        quantity: Number(mapping.quantity),
        appliedUnitPrice: Number(mapping.appliedUnitPrice),
      })
      .catch((err) => console.error("Audit log error:", err.message));

    res.status(201).json(mapping);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const removeShipmentService = async (req, res) => {
  try {
    await assertShipmentIsOpen(req.params.id);

    const mapping =
      await shipmentServiceMappingLogic.getShipmentServiceMappingById(
        req.params.mappingId,
      );
    if (!mapping || mapping.shipmentId !== req.params.id) {
      return res.status(404).json({ error: "Shipment service not found." });
    }

    await shipmentServiceMappingLogic.deleteShipmentServiceMapping(
      req.params.mappingId,
    );

    await auditLogLogic
      .createAuditLog(req.user.id, "SHIPMENT_SERVICE_REMOVED", {
        shipmentId: req.params.id,
        serviceId: mapping.serviceId,
      })
      .catch((err) => console.error("Audit log error:", err.message));

    res.status(200).json({ message: "Service removed from shipment." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  listShipmentServices,
  addShipmentService,
  removeShipmentService,
};
