const shipmentItemLogic = require("../logic/shipment_item.logic");

const createShipmentItem = async (req, res) => {
  try {
    const shipmentItemData = req.body;
    const newShipmentItem =
      await shipmentItemLogic.createShipmentItem(shipmentItemData);
    res.status(201).json(newShipmentItem);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getShipmentItemsByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const shipmentItems = await shipmentItemLogic.getShipmentItemsByField(
      field,
      value,
    );
    res.status(200).json(shipmentItems);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateShipmentItem = async (req, res) => {
  try {
    const { id } = req.params;
    const shipmentItemData = req.body;
    const updatedShipmentItem = await shipmentItemLogic.updateShipmentItem(
      id,
      shipmentItemData,
    );
    res.status(200).json(updatedShipmentItem);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteShipmentItem = async (req, res) => {
  try {
    const { id } = req.params;
    await shipmentItemLogic.deleteShipmentItem(id);
    res.status(200).json({ message: "Shipment item deleted successfully." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createShipmentItem,
  getShipmentItemsByField,
  updateShipmentItem,
  deleteShipmentItem,
};
