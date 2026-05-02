const prisma = require('../lib/prisma');

const prismaUser = prisma.user;

const PUBLIC_USER_SELECT = {
    id: true,
    name: true,
    email: true,
    createdAt: true,
    updatedAt: true,
};


const createUser = async (userData) => {
    return await prismaUser.create({
        data: userData,
        select: PUBLIC_USER_SELECT,
    });
}

const getAllUsers = async () => {
    return await prismaUser.findMany({
        select: PUBLIC_USER_SELECT,
    });
}

const getUserByField = async (field, value) => {
    return await prismaUser.findUnique({
        where: { [field]: value },
        select: PUBLIC_USER_SELECT,
    });
}

const updateUser = async (id, updateData) => {
    return await prismaUser.update({
        where: { id },
        data: updateData,
        select: PUBLIC_USER_SELECT,
    });
}

const deleteUser = async (id) => {
    return await prismaUser.delete({
        where: { id },
        select: PUBLIC_USER_SELECT,
    });
}

module.exports = {
    createUser,
    getAllUsers,
    getUserByField,
    updateUser,
    deleteUser,
}