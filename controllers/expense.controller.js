const path = require("path");
const expenseLogic = require("../logic/expense.logic");
const {
  uploadBuffer,
  getObjectStream,
  objectExists,
} = require("../lib/objectStorage");

const getAdminUserId = (req) => {
  return req.user && req.user.id;
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

    const ext = path.extname(req.file.originalname).toLowerCase();
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const filename = `receipt-${uniqueSuffix}${ext}`;

    await uploadBuffer(filename, req.file.buffer, req.file.mimetype);

    res.status(201).json({
      url: `/api/expenses/receipt/${filename}`,
      originalName: req.file.originalname,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const getReceipt = async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename || filename !== path.basename(filename)) {
      return res.status(400).json({ error: "Invalid file name." });
    }

    const exists = await objectExists(filename);
    if (!exists) {
      return res.status(404).json({ error: "Receipt not found." });
    }

    const { stream, contentType } = await getObjectStream(filename);
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    stream.pipe(res);
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "Receipt not found." });
    }
    return res.status(400).json({ error: err.message });
  }
};

module.exports = {
  createCategory,
  getAllCategories,
  createExpense,
  getAllExpenses,
  deleteExpense,
  uploadReceipt,
  getReceipt,
};
