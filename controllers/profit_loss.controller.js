const profitLossLogic = require("../logic/profit_loss.logic");

const getPLSummary = async (req, res) => {
  try {
    const { monthYear } = req.query;
    const result = await profitLossLogic.getPLSummary(monthYear);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getPLTrends = async (req, res) => {
  try {
    const { months } = req.query;
    const count = months ? parseInt(months) : 6;
    const result = await profitLossLogic.getPLTrends(count);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getClientProfitability = async (req, res) => {
  try {
    const { monthYear } = req.query;
    const result = await profitLossLogic.getClientProfitability(monthYear);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getPLSummary,
  getPLTrends,
  getClientProfitability,
};
