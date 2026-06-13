const { prisma } = require('../lib/prisma');

const prismaEmployee = prisma.employee;

// const PUBLIC_EMPLOYEE_SELECT = {
//     username: true, // Get the username for the corresponding user through UserId
//     email: true,
//     jobTitle: true,
//     // wageRate: true,
//     createdAt: true,
//     updatedAt: true,
// };

const createEmployee = async (employeeData) => {
    return await prismaEmployee.create({
        data: employeeData,
        // select: PUBLIC_EMPLOYEE_SELECT,
    });
}

const getAllEmployees = async () => {
    return await prismaEmployee.findMany({
        include: { user: true },
    });
}

const getEmployeeByField = async (field, value) => {
    return await prismaEmployee.findUnique({
        where: { [field]: value },
        include: { user: true },
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