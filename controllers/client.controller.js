const clientLogic = require('../logic/client.logic');

// US-010 & US-011: Admin adds a new client; email is sent automatically
const addClient = async (req, res) => {
  try {
    const result = await clientLogic.addClient(req.body);
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

const getClientById = async (req, res) => {
  try {
    const client = await clientLogic.getClientById(req.params.id);
    res.status(200).json(client);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

module.exports = { addClient, getAllClients, getClientById };
