const { prisma } = require('../lib/prisma');

const prismaEmployee = prisma.employee;

// User fields that are safe to return alongside an employee record.
// Never includes passwordHash.
const PUBLIC_USER_SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    username: true,
    email: true,
    role: true,
    isActive: true,
};

const createEmployee = async (employeeData) => {
    return await prismaEmployee.create({
        data: employeeData,
    });
}

const getAllEmployees = async () => {
    return await prismaEmployee.findMany({
        include: { user: { select: PUBLIC_USER_SELECT } },
    });
}

const getEmployeeByField = async (field, value) => {
    return await prismaEmployee.findUnique({
        where: { [field]: value },
        include: { user: { select: PUBLIC_USER_SELECT } },
    });
}

const updateEmployee = async (id, updateData) => {
    return await prismaEmployee.update({
        where: { id },
        data: updateData,
        // select: PUBLIC_EMPLOYEE_SELECT,
    });
}

const deleteEmployee = async (id) => {
    return await prismaEmployee.delete({
        where: { id },
        // select: PUBLIC_EMPLOYEE_SELECT,
    });
}

module.exports = {
    createEmployee,
    getAllEmployees,
    getEmployeeByField,
    updateEmployee,
    deleteEmployee,
}