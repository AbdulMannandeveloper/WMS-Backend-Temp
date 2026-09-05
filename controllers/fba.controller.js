const fbaLogic = require('../logic/fba.logic');
const { resolveOwnClientId } = require('../utils/clientScope');

const fail = (res, error) => {
  const notFound = /not found/i.test(error.message);
  res.status(notFound ? 404 : 400).json({ error: error.message });
};

// ─── Categories ───────────────────────────────────────────────────────────────

const createCategory = async (req, res) => {
  try {
    res.status(201).json(await fbaLogic.addCategory(req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const listCategories = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.getAllCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.updateCategory(req.params.id, req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const deleteCategory = async (req, res) => {
  try {
    res.status(200).json(await fbaLogic.deleteCategory(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

// ─── Consignments ─────────────────────────────────────────────────────────────

const recordArrival = async (req, res) => {
  try {
    res.status(201).json(await fbaLogic.recordArrival(req.body, req.user.id));
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
      ? await fbaLogic.getShipmentsByClientId(ownClientId)
      : await fbaLogic.getAllShipments();
    res.status(200).json(shipments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getShipment = async (req, res) => {
  try {
    const ownClientId = await resolveOwnClientId(req.user);
    const shipment = await fbaLogic.getShipmentById(req.params.id);
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
    res.status(200).json(await fbaLogic.recordDispatch(req.params.id, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const cancelShipment = async (req, res) => {
  try {
    res
      .status(200)
      .json(await fbaLogic.cancel(req.params.id, req.body?.reason, req.user.id));
  } catch (err) {
    fail(res, err);
  }
};

const deleteShipment = async (req, res) => {
  try {
    await fbaLogic.remove(req.params.id, req.user.id);
    res.status(200).json({ message: 'Consignment deleted.' });
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
  deleteShipment,
};
