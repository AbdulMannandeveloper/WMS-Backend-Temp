const { prisma } = require('../lib/prisma');

const prismaClient = prisma.client;

const createClient = async (clientData) => {
    return await prismaClient.create({
        data: clientData,
    });
}

const getAllClients = async () => {
    return await prismaClient.findMany({
        // select: PUBLIC_CLIENT_SELECT,
    });
}

const getClientByField = async (field, value) => {
    return await prismaClient.findUnique({
        where: { [field]: value },
        // select: PUBLIC_CLIENT_SELECT,
    });
}

const updateClient = async (id, updateData) => {
    return await prismaClient.update({
        where: { id },
        data: updateData,
        // select: PUBLIC_CLIENT_SELECT,
    });
}

const deleteClient = async (id) => {
    return await prismaClient.delete({
        where: { id },
        // select: PUBLIC_CLIENT_SELECT,
    });
}

module.exports = {
    createClient,
    getAllClients,
    getClientByField,
    updateClient,
    deleteClient,
}
