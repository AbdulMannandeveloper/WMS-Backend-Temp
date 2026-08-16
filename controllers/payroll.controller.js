const payrollLogic = require("../logic/payroll.logic");

const getAdminUserId = (req) => {
  return req.user && req.user.id;
};

const setBaseSalary = async (req, res) => {
  try {
    const { id } = req.params; // employeeId
    const { amount } = req.body;
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.setBaseSalary(id, amount, adminUserId);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const createFineRule = async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.createFineRule(req.body, adminUserId);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getActiveFineRule = async (req, res) => {
  try {
    const result = await payrollLogic.getActiveFineRule();
    res.status(200).json(result || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createFine = async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.createFine(req.body, adminUserId);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const toggleCancelFine = async (req, res) => {
  try {
    const { id } = req.params; // fineId
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.toggleCancelFine(id, adminUserId);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const createBonus = async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.createBonus(req.body, adminUserId);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getSalaryBreakdownForEmployee = async (req, res) => {
  try {
    const userId = getAdminUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized. Missing user credentials." });
    }
    const { monthYear } = req.query;
    const result = await payrollLogic.getSalaryBreakdownForEmployee(userId, monthYear);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getSalarySummaryForAll = async (req, res) => {
  try {
    const { monthYear } = req.query;
    const result = await payrollLogic.getSalarySummaryForAll(monthYear);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const finalizePayroll = async (req, res) => {
  try {
    const { monthYear } = req.body;
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.finalizePayroll(monthYear, adminUserId);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  setBaseSalary,
  createFineRule,
  getActiveFineRule,
  createFine,
  toggleCancelFine,
  createBonus,
  getSalaryBreakdownForEmployee,
  getSalarySummaryForAll,
  finalizePayroll,
};
