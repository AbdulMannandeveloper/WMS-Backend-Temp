const clientLogic = require('../logic/client.logic');
const { dependentsBody } = require('../utils/dependents');

// US-010 & US-011: Admin adds a new client; email is sent automatically
const addClient = async (req, res) => {
  try {
    const result = await clientLogic.addClient({ ...req.body, adminId: req.user.id });
    res.status(201).json({
      message: 'Client added successfully. An invitation email has been sent.',
      ...result,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getAllClients = async (req, res) => {
  try {
    const clients = await clientLogic.getAllClients();
    res.status(200).json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Slim client list for employee-facing dropdowns (id + companyName only).
const getClientLookup = async (req, res) => {
  try {
    const clients = await clientLogic.getClientLookupList();
    res.status(200).json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// A client reads its own record. The id comes from the session, never the request,
// so a client can never resolve another client's details.
const getMyClient = async (req, res) => {
  try {
    const client = await clientLogic.getClientByUserId(req.user.id);
    res.status(200).json(client);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

const getClientById = async (req, res) => {
  try {
    const client = await clientLogic.getClientById(req.params.id);
    res.status(200).json(client);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

const updateClient = async (req, res) => {
  try {
    const updated = await clientLogic.updateClient(req.params.id, req.body, req.user.id);
    res.status(200).json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// What would stop a delete, asked before the admin presses it.
const getClientDependents = async (req, res) => {
  try {
    const { report } = await clientLogic.getClientDependents(req.params.id);
    res.status(200).json(report);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

const setClientActive = async (req, res) => {
  try {
    const client = await clientLogic.setClientActive(req.params.id, req.body?.isActive, req.user.id);
    res.status(200).json({
      message: client.accountStatus === 'active' ? 'Client reactivated.' : 'Client deactivated.',
      client,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

const deleteClient = async (req, res) => {
  try {
    await clientLogic.deleteClient(req.params.id, req.user.id);
    res.status(200).json({ message: 'Client deleted successfully.' });
  } catch (err) {
    if (err.code === 'HAS_DEPENDENTS') {
      return res.status(409).json(dependentsBody(err));
    }
    res.status(err.status || 400).json({ error: err.message });
  }
};

module.exports = {
  addClient,
  getAllClients,
  getClientLookup,
  getMyClient,
  getClientById,
  updateClient,
  getClientDependents,
  setClientActive,
  deleteClient,
};
