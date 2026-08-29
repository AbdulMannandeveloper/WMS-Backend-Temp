require("dotenv").config();

const { connectDB, prisma } = require("./lib/prisma");
const { getRedisClient, disconnectRedis } = require("./lib/redis");
const { app, setShuttingDown, isShuttingDown } = require("./app");

const PORT = process.env.PORT || 5000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);

let server = null;

const shutdown = async (signal) => {
  if (isShuttingDown()) return;
  setShuttingDown(true);
  console.log(`[Shutdown] Received ${signal}, closing gracefully...`);

  const forceTimer = setTimeout(() => {
    console.error("[Shutdown] Timed out — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref?.();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      console.log("[Shutdown] HTTP server closed");
    }
    await disconnectRedis();
    await prisma.$disconnect();
    console.log("[Shutdown] Resources released");
    process.exit(0);
  } catch (err) {
    console.error("[Shutdown] Error during shutdown:", err.message);
    process.exit(1);
  }
};

const startServer = async () => {
  try {
    await connectDB();
    await getRedisClient();
    server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();

module.exports = app;
