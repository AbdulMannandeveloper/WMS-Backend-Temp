const fdaLogic = require('../logic/fda.logic');
const { resolveOwnClientId } = require('../utils/clientScope');

const fail = (res, error) => {
  const notFound = /not found/i.test(error.message);
  res.status(notFound ? 404 : 400).json({ error: error.message });
};

// ─── Categories ───────────────────────────────────────────────────────────────

const createCategory = async (req, res) => {
  try {
    res.status(201).json(await fdaLogic.addCategory(req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const listCategories = async (req, res) => {
  try {
    res.status(200).json(await fdaLogic.getAllCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    res.status(200).json(await fdaLogic.updateCategory(req.params.id, req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const deleteCategory = async (req, res) => {
  try {
    res.status(200).json(await fdaLogic.deleteCategory(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

// ─── Consignments ─────────────────────────────────────────────────────────────

const recordArrival = async (req, res) => {
  try {
    res.status(201).json(await fdaLogic.recordArrival(req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

/**
 * A client sees only their own consignments; staff see everything. Scoped the
 * same way as invoices, through resolveOwnClientId.
 */
const listShipments = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const shipments = ownClientId
      ? await fdaLogic.getShipmentsByClientId(ownClientId)
      : await fdaLogic.getAllShipments();
    res.status(200).json(shipments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getShipment = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const shipment = await fdaLogic.getShipmentById(req.params.id);
    // 404 rather than 403 for someone else's, so a client cannot probe which
    // consignment ids exist outside their own account.
    if (ownClientId && shipment.clientId !== ownClientId) {
      return res.status(404).json({ error: 'Consignment not found.' });
    }
    res.status(200).json(shipment);
  } catch (err) {
    fail(res, err);
  }
};

const dispatchShipment = async (req, res) => {
  try {
    res.status(200).json(await fdaLogic.recordDispatch(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const cancelShipment = async (req, res) => {
  try {
    res
      .status(200)
      .json(await fdaLogic.cancel(req.params.id, req.body?.reason, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

module.exports = {
  createCategory,
  listCategories,
  updateCategory,
  deleteCategory,
  recordArrival,
  listShipments,
  getShipment,
  dispatchShipment,
  cancelShipment,
};
