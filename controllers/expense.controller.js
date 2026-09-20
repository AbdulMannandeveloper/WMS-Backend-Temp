const path = require("path");
const expenseLogic = require("../logic/expense.logic");
const { paginatedResponse } = require("../utils/pagination");
const { buildListQuery } = require("../utils/queryFilters");
const { listError } = require("../utils/listResponse");
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
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      expenseLogic.EXPENSE_LIST_SPEC,
    );

    const result = await expenseLogic.getAllExpenses(where, {
      orderBy,
      pagination,
    });

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (err) {
    return listError(res, err, "getAllExpenses");
  }
};

/**
 * The cards above the table: a grand total, and one per category.
 *
 * Same query string through the same spec, so these describe exactly the rows
 * the list is paging — and all of them, rather than the fifty on screen. Both
 * figures were computed in the browser from the whole array before, so without
 * this the totals would have silently become per-page.
 */
const getExpenseSummary = async (req, res) => {
  try {
    const { where } = buildListQuery(req.query, expenseLogic.EXPENSE_LIST_SPEC);
    return res.status(200).json(await expenseLogic.summariseExpenses(where));
  } catch (err) {
    return listError(res, err, "getExpenseSummary");
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
  getExpenseSummary,
  createCategory,
  getAllCategories,
  createExpense,
  getAllExpenses,
  deleteExpense,
  uploadReceipt,
  getReceipt,
};
