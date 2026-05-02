const prisma = require('../lib/prisma');

const PUBLIC_EMPLOYEE_SELECT = {
    id: true,
    name: true,
    email: true,
    position: true,
    createdAt: true,
    updatedAt: true,
};