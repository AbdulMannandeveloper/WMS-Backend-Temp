const employeeLogic = require('../logic/employee.logic');

// Admin adds a new employee; invitation email sent automatically
const addEmployee = async (req, res) => {
  try {
    const result = await employeeLogic.addEmployee(req.body);
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

const getEmployeeById = async (req, res) => {
  try {
    const employee = await employeeLogic.getEmployeeById(req.params.id);
    res.status(200).json(employee);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
};

module.exports = { addEmployee, getAllEmployees, getEmployeeById };
