const employeeLogic = require('../logic/employee.logic');

// Admin adds a new employee; invitation email sent automatically
const addEmployee = async (req, res) => {
  try {
    // adminId from the session, never the body — otherwise any admin could act
    // as any other, and the audit trail would name whoever the caller chose.
    const result = await employeeLogic.addEmployee({
      ...req.body,
      adminId: req.user.id,
    });
    res.status(201).json({
      message: 'Employee added successfully. An invitation email has been sent.',
      ...result,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getAllEmployees = async (req, res) => {
  try {
    const employees = await employeeLogic.getAllEmployees();
    res.status(200).json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getEmployeeLookup = async (req, res) => {
  try {
    res.status(200).json(await employeeLogic.getEmployeeLookupList());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getEmployeeById = async (req, res) => {
  try {
    const employee = await employeeLogic.getEmployeeById(req.params.id, req.user);
    res.status(200).json(employee);
  } catch (err) {
    res.status(err.status || 404).json({ error: err.message });
  }
};

module.exports = {
  addEmployee,
  getAllEmployees,
  getEmployeeLookup,
  getEmployeeById,
};
