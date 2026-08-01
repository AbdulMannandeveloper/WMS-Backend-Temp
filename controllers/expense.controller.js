const expenseLogic = require("../logic/expense.logic");

const getAdminUserId = (req) => {
  return req.header("x-user-id") || (req.user && req.user.id);
};

const createCategory = async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    const category = await expenseLogic.createCategory(req.body, adminUserId);
    res.status(201).json(category);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getAllCategories = async (req, res) => {
  try {
    const categories = await expenseLogic.getAllCategories();
    res.status(200).json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createExpense = async (req, res) => {
  try {
    const adminUserId = getAdminUserId(req);
    const expense = await expenseLogic.createExpense(req.body, adminUserId);
    res.status(201).json(expense);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getAllExpenses = async (req, res) => {
  try {
    const { categoryId, startDate, endDate } = req.query;
    const expenses = await expenseLogic.getAllExpenses({
      categoryId,
      startDate,
      endDate,
    });
    res.status(200).json(expenses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUserId = getAdminUserId(req);
    await expenseLogic.deleteExpense(id, adminUserId);
    res.status(200).json({ message: "Expense deleted successfully." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const uploadReceipt = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    // Return relative URL that is served statically by express app.use(express.static('public'))
    res.status(201).json({
      url: `/uploads/${req.file.filename}`,
      originalName: req.file.originalname,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

module.exports = {
  createCategory,
  getAllCategories,
  createExpense,
  getAllExpenses,
  deleteExpense,
  uploadReceipt,
};
