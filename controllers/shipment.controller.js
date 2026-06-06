const shipmentLogic = require("../logic/shipment.logic");

const createShipment = async (req, res) => {
  try {
    const shipmentData = req.body;
    const newShipment = await shipmentLogic.createShipment(shipmentData);
    res.status(201).json(newShipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const dispatchShipment = async (req, res) => {
  try {
    const { shipmentId } = req.params;
    await shipmentLogic.dispatchShipment(shipmentId);
    res.status(200).json({ message: "Shipment dispatched successfully." });
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
    const shipmentData = req.body;
    const updatedShipment = await shipmentLogic.updateShipment(
      id,
      shipmentData,
    );
    res.status(200).json(updatedShipment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteShipment = async (req, res) => {
  try {
    const { id } = req.params;
    await shipmentLogic.deleteShipment(id);
    res.status(200).json({ message: "Shipment deleted successfully." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createShipment,
  getShipmentByField,
  getShipmentsByClientId,
  dispatchShipment,
  updateShipment,
  deleteShipment,
};
