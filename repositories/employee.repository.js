const { prisma } = require('../lib/prisma');

const prismaEmployee = prisma.employee;

const createEmployee = async (employeeData) => {
    return await prismaEmployee.create({
        data: employeeData,
    });
}

const getAllEmployees = async () => {
    return await prismaEmployee.findMany();
}

const getEmployeeByField = async (field, value) => {
    return await prismaEmployee.findUnique({
        where: { [field]: value },
    });
}

const updateEmployee = async (id, updateData) => {
    return await prismaEmployee.update({
        where: { id },
        data: updateData,
    });
}

const deleteEmployee = async (id) => {
    return await prismaEmployee.delete({
        where: { id },
    });
}

module.exports = {
    createEmployee,
    getAllEmployees,
    getEmployeeByField,
    updateEmployee,
    deleteEmployee,
}