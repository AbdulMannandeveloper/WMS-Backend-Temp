const { canAccessClientId } = require("../utils/clientScope");
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
// trackingId is deliberately absent — it has its own endpoint, because it is
// the one field that legitimately changes after dispatch, and because staff (not
// just admins) need to record it.
const SHIPMENT_UPDATE_FIELDS = [
  "shipmentType",
  "packagingType",
  "courierName",
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

/**
 * Records the courier consignment number. Staff, and allowed after dispatch —
 * that is usually when the courier issues it.
 */
const setShipmentTracking = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await shipmentLogic.setShipmentTracking(
      id,
      req.body?.trackingId ?? null,
      req.user.id,
    );
    res.status(200).json(updated);
  } catch (error) {
    const notFound = error.message === "Shipment not found.";
    res.status(notFound ? 404 : 400).json({ error: error.message });
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

/**
 * A client's shipments. Staff may read any; a client only their own.
 *
 * 404 rather than 403 for someone else's, matching the invoice and FDA reads —
 * a 403 would confirm the client id exists, which is a probe.
 *
 * The rows carry sourceLocationId on their items. That is our warehouse layout
 * rather than the client's business, so the portal does not render it; if this
 * ever needs to be airtight the trimming belongs here, not in the browser.
 */
const getShipmentsByClientId = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!(await canAccessClientId(req.user, clientId))) {
      return res.status(404).json({ error: "Client not found." });
    }

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
  setShipmentTracking,
  deleteShipment,
};
