const { prisma } = require('../lib/prisma');

const prismaClient = prisma.client;

const createClient = async (clientData) => {
    return await prismaClient.create({
        data: clientData,
    });
}

const getAllClients = async () => {
    return await prismaClient.findMany();
}

const getClientByField = async (field, value) => {
    return await prismaClient.findUnique({
        where: { [field]: value },
    });
}

const updateClient = async (id, updateData) => {
    return await prismaClient.update({
        where: { id },
        data: updateData,
    });
}

const deleteClient = async (id) => {
    return await prismaClient.delete({
        where: { id },
    });
}

module.exports = {
    createClient,
    getAllClients,
    getClientByField,
    updateClient,
    deleteClient,
}
