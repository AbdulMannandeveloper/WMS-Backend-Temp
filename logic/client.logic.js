const clientRepository = require('../repositories/client.repository');
const userRepository = require('../repositories/user.repository');

const addNewClient = async (clientData) => {
    if (!clientData.userId) {
        throw new Error('User ID is required to create a client.');
    }
    
    const userData = await userRepository.getUserById(clientData.userId);
    if (!userData) {
        throw new Error('User not found. Cannot create client without a valid user.');
    }
    if (userData.role !== 'client') {
        throw new Error('User role must be "client" to create a client entry.');
    }

    // Client Unique Number Generation


  return await clientRepository.createClientEntry(clientData);
};

const getAllClients = async () => {
  return await clientRepository.getAllClients();
};

const getClientById = async (id) => {
  return await clientRepository.getClientById(id);
};

const updateClient = async (id, clientData) => {
  return await clientRepository.updateClient(id, clientData);
};

const deleteClient = async (id) => {
  // Don't delete if there are active orders associated with the client
  return await clientRepository.deleteClient(id);
};

module.exports = {
  addNewClient,
  getAllClients,
  getClientById,
  updateClient,
  deleteClient,
};
