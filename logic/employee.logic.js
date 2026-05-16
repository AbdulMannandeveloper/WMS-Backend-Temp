const employeeRepository = require("../repositories/employee.repository");

const createEmployee = async (employeeData) => {
    return await employeeRepository.createEmployee(employeeData);
}

const getAllEmployees = async () => {
    return await employeeRepository.getAllEmployees();
}

const getEmployeeByField = async (field, value) => {
    return await employeeRepository.getEmployeeByField(field, value);
}

const updateEmployee = async (id, updateData) => {
    return await employeeRepository.updateEmployee(id, updateData);
}

const deleteEmployee = async (id) => {
    return await employeeRepository.deleteEmployee(id);
}

module.exports = {
    createEmployee,
    getAllEmployees,
    getEmployeeByField,
    updateEmployee,
    deleteEmployee
}