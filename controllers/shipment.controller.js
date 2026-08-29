const shipmentLogic = require("../logic/shipment.logic");
const { pick } = require("../utils/pick");

const SHIPMENT_CREATE_FIELDS = [
  "employeeId",
  "clientId",
  "shipmentType",
  "status",
  "packagingType",
  "courierName",
  "shipmentItems",
  "shipmentServices",
];
// status is deliberately absent — it moves only through the transition
// endpoints below, which enforce the state machine. Admin-only at the route.
const SHIPMENT_UPDATE_FIELDS = [
  "shipmentType",
  "packagingType",
  "courierName",
  "trackingId",
];

const createShipment = async (req, res) => {
  try {
    const shipmentData = pick(req.body, SHIPMENT_CREATE_FIELDS);

    // Attaching a billable service is an admin action wherever it happens —
    // POST /:id/services is admin-only, so accepting them here from an employee
    // would be a way around that. Refuse rather than dropping them silently.
    if (
      Array.isArray(shipmentData.shipmentServices) &&
      shipmentData.shipmentServices.length > 0 &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({
        error:
          "Only an admin can add billable services to a shipment. Create the shipment, then ask an admin to add them.",
      });
    }

    const newShipment = await shipmentLogic.createShipment(shipmentData);
    res.status(201).json(newShipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const dispatchShipment = async (req, res) => {
  try {
    const { shipmentId } = req.params;
    await shipmentLogic.dispatchShipment(shipmentId, req.user.id);
    res.status(200).json({ message: "Shipment dispatched successfully." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const markShipmentReady = async (req, res) => {
  try {
    const shipment = await shipmentLogic.markShipmentReady(
      req.params.id,
      req.user.id,
    );
    res.status(200).json(shipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const reopenShipment = async (req, res) => {
  try {
    const shipment = await shipmentLogic.reopenShipment(
      req.params.id,
      req.user.id,
    );
    res.status(200).json(shipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const cancelShipment = async (req, res) => {
  try {
    const shipment = await shipmentLogic.cancelShipment(
      req.params.id,
      req.user.id,
      req.body?.reason,
    );
    res.status(200).json(shipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getShipmentByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const shipment = await shipmentLogic.getShipmentByField(field, value);
    if (!shipment) {
      return res.status(404).json({ error: "Shipment not found." });
    }
    res.status(200).json(shipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getShipmentsByClientId = async (req, res) => {
  try {
    const { clientId } = req.params;
    const shipments = await shipmentLogic.getShipmentsByClientId(clientId);
    res.status(200).json(shipments);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateShipment = async (req, res) => {
  try {
    const { id } = req.params;
    const shipmentData = pick(req.body, SHIPMENT_UPDATE_FIELDS);
    const updatedShipment = await shipmentLogic.updateShipment(
      id,
      shipmentData,
      req.user.id,
    );
    res.status(200).json(updatedShipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteShipment = async (req, res) => {
  try {
    const { id } = req.params;
    await shipmentLogic.deleteShipment(id, req.user.id);
    res.status(200).json({ message: "Shipment deleted successfully." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllShipments = async (req, res) => {
  try {
    const shipments = await shipmentLogic.getAllShipments();
    res.status(200).json(shipments);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createShipment,
  getAllShipments,
  getShipmentByField,
  getShipmentsByClientId,
  dispatchShipment,
  markShipmentReady,
  reopenShipment,
  cancelShipment,
  updateShipment,
  deleteShipment,
};
