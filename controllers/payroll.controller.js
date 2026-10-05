const payrollLogic = require("../logic/payroll.logic");

const getAdminUserId = (req) => {
  return req.user && req.user.id;
};

/** 404 for a missing row, the logic's own status (409: month finalised), else 400. */
const failWith = (res, err) =>
  res
    .status(err.status || (/not found/i.test(err.message) ? 404 : 400))
    .json({ error: err.message });

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
    failWith(res, err);
  }
};

const toggleCancelFine = async (req, res) => {
  try {
    const { id } = req.params; // fineId
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.toggleCancelFine(id, adminUserId);
    res.status(200).json(result);
  } catch (err) {
    failWith(res, err);
  }
};

const deleteFineRule = async (req, res) => {
  try {
    res.status(200).json(await payrollLogic.deleteFineRule(req.params.id, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};

const updateFine = async (req, res) => {
  try {
    res.status(200).json(await payrollLogic.updateFine(req.params.id, req.body, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};

const deleteFine = async (req, res) => {
  try {
    res.status(200).json(await payrollLogic.deleteFine(req.params.id, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};

const updateBonus = async (req, res) => {
  try {
    res.status(200).json(await payrollLogic.updateBonus(req.params.id, req.body, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};

const deleteBonus = async (req, res) => {
  try {
    res.status(200).json(await payrollLogic.deleteBonus(req.params.id, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};

const createBonus = async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    const result = await payrollLogic.createBonus(req.body, adminUserId);
    res.status(201).json(result);
  } catch (err) {
    failWith(res, err);
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

const getReopenDependents = async (req, res) => {
  try {
    const { report } = await payrollLogic.getReopenDependents(req.params.monthYear);
    res.status(200).json(report);
  } catch (err) {
    failWith(res, err);
  }
};

const reopenPayroll = async (req, res) => {
  try {
    res.status(200).json(await payrollLogic.reopenPayroll(req.params.monthYear, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};

// TESTING-ONLY start
const getPayRecordDependents = async (req, res) => {
  try {
    const { report } = await payrollLogic.getPayRecordDependents(req.params.monthYear, req.params.userId);
    res.status(200).json(report);
  } catch (err) {
    failWith(res, err);
  }
};

const deletePayRecord = async (req, res) => {
  try {
    res
      .status(200)
      .json(await payrollLogic.deletePayRecord(req.params.monthYear, req.params.userId, getAdminUserId(req)));
  } catch (err) {
    failWith(res, err);
  }
};
// TESTING-ONLY end

module.exports = {
  setBaseSalary,
  createFineRule,
  getActiveFineRule,
  createFine,
  toggleCancelFine,
  deleteFineRule,
  updateFine,
  deleteFine,
  updateBonus,
  deleteBonus,
  createBonus,
  getSalaryBreakdownForEmployee,
  getSalarySummaryForAll,
  finalizePayroll,
  getReopenDependents,
  reopenPayroll,
  // TESTING-ONLY start
  getPayRecordDependents,
  deletePayRecord,
  // TESTING-ONLY end
};
