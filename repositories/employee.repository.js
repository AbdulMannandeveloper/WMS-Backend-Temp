const crypto = require('crypto');
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

/**
 * Generates an employee number: EMP-XXXXXXXX.
 *
 * The schema declares @default(dbgenerated()) on employee_unique_number, but the
 * column has no database default and is NOT NULL — the number has always come
 * from application code. Generated here rather than at each call site so it is
 * impossible to write an Employee without one; forgetting it is a null
 * constraint violation surfaced to the user as a 400 with a Prisma stack trace.
 */
const generateEmployeeNumber = () =>
    'EMP-' + crypto.randomBytes(4).toString('hex').toUpperCase();

const createEmployee = async (employeeData) => {
    return await prismaEmployee.create({
        data: {
            employeeUniqueNumber: generateEmployeeNumber(),
            ...employeeData,
        },
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
    generateEmployeeNumber,
    getAllEmployees,
    getEmployeeByField,
    updateEmployee,
    deleteEmployee,
}