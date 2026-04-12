const getHealthStatus = (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'ProPackers API',
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  getHealthStatus,
};
