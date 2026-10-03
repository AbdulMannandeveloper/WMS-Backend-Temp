const stockLevelLogic = require("../logic/stock_level.logic");
const { pick } = require("../utils/pick");
const { parsePagination, paginatedResponse } = require("../utils/pagination");
const { resolveOwnClientId, resolveClientFilter } = require('../utils/clientScope');
const { buildListQuery, parseUuid, withScope } = require('../utils/queryFilters');
const { listError } = require('../utils/listResponse');

const STOCK_CREATE_FIELDS = [
  "productId",
  "locationId",
  "currentQuantity",
  "reservedQuantity",
  "arrivedTodayQuantity",
];

const createStockLevel = async (req, res) => {
  try {
    const stockLevelData = pick(req.body, STOCK_CREATE_FIELDS);
    const stockLevel = await stockLevelLogic.createStockLevel(stockLevelData);
    res.status(201).json(stockLevel);
  } catch (error) {
    // A refusal that carries its own status (409: quantities, deactivated) says so.
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    // Handle validation errors and other issues gracefully
    if (error.message.includes("not found")) {
      return res.status(404).json({ error: error.message });
    }

    if (
      error.message.includes("required") ||
      error.message.includes("negative")
    ) {
      return res.status(400).json({ error: error.message });
    }

    // For unexpected errors, return a generic server error response
    res.status(500).json({ error: "An unexpected error occurred." });
  }
};

const getAllStockLevels = async (req, res) => {
  try {
    // Clients see stock for their own products only; staff see everything and
    // may point clientId wherever they like.
    const scope = await resolveClientFilter(
      req.user,
      parseUuid(req.query.clientId, 'clientId'),
    );
    const { where, orderBy, pagination } = buildListQuery(
      req.query,
      stockLevelLogic.STOCK_LEVEL_LIST_SPEC,
    );

    const result = await stockLevelLogic.getAllStockLevels(
      withScope(where, scope ? stockLevelLogic.clientScopeClause(scope) : null),
      { orderBy, pagination },
    );

    return res
      .status(200)
      .json(paginatedResponse(result.items, result.total, pagination));
  } catch (error) {
    return listError(res, error, 'getAllStockLevels');
  }
};

/** Units on hand and reserved, across the whole filtered set. */
const getStockLevelSummary = async (req, res) => {
  try {
    const scope = await resolveClientFilter(
      req.user,
      parseUuid(req.query.clientId, 'clientId'),
    );
    const { where } = buildListQuery(
      req.query,
      stockLevelLogic.STOCK_LEVEL_LIST_SPEC,
    );

    return res.status(200).json(
      await stockLevelLogic.summariseStockLevels(
        withScope(where, scope ? stockLevelLogic.clientScopeClause(scope) : null),
      ),
    );
  } catch (error) {
    return listError(res, error, 'getStockLevelSummary');
  }
};

const getStockLevelByField = async (req, res) => {
  try {
    const { field, value } = req.params;
    const stockLevel = await stockLevelLogic.getStockLevelByField(field, value);
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getStockLevelByProductId = async (req, res) => {
  try {
    const { productId } = req.params;
    const stockLevel = await stockLevelLogic.getStockLevelByField(
      "productId",
      productId,
    );
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getStockLevelByLocationId = async (req, res) => {
  try {
    const { locationId } = req.params;
    const stockLevel = await stockLevelLogic.getStockLevelByField(
      "locationId",
      locationId,
    );
    if (!stockLevel) {
      return res.status(404).json({ error: "Stock level not found." });
    }
    res.status(200).json(stockLevel);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Quantities are never edited directly; both edit routes answer 409 or 404.
// See stockLevelLogic.refuseStockEdit.
const updateStockLevel = async (req, res) => {
  try {
    await stockLevelLogic.refuseStockEdit({ id: req.params.id });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
};

const updateStockLevelByProductAndLocation = async (req, res) => {
  try {
    const { productId, locationId } = req.params;
    await stockLevelLogic.refuseStockEdit({ productId, locationId });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
};

const deleteStockLevel = async (req, res) => {
  try {
    const stockLevel = await stockLevelLogic.deleteStockLevel(req.params.id, req.user.id);
    res
      .status(200)
      .json({ message: "Stock level deleted successfully.", stockLevel });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
};

module.exports = {
  getStockLevelSummary,
  createStockLevel,
  getAllStockLevels,
  getStockLevelByField,
  getStockLevelByProductId,
  getStockLevelByLocationId,
  updateStockLevel,
  updateStockLevelByProductAndLocation,
  deleteStockLevel,
};
