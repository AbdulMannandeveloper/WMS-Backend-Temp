require("dotenv").config();

// Prefer IPv4 when a host publishes both.
//
// Several hosts — Render among them — have no IPv6 route, so resolving a
// dual-stack name like smtp.gmail.com to its AAAA record fails with
// ENETUNREACH before a connection is even attempted. This has now cost us twice:
// once on the database host, once on outbound mail. Preferring A records costs
// nothing where IPv6 works, and prevents a class of failure whose error message
// points at the network rather than at the lookup.
require("node:dns").setDefaultResultOrder("ipv4first");

const { connectDB, prisma } = require("./lib/prisma");
const { getRedisClient, disconnectRedis } = require("./lib/redis");
const { app, setShuttingDown, isShuttingDown } = require("./app");
const { recoverStranded } = require("./utils/mailQueue");
const { describeMailTransport } = require("./utils/mailer");
const {
  ensureShipmentService,
  ensureFbaService,
} = require("./logic/billing_services");

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
    // Mail a previous worker had claimed but not finished when it died goes back
    // on the queue. No-op without Redis.
    await recoverStranded();

    // Say what will happen to email. Mock mode is the default, and a silent
    // default is what makes a mail misconfiguration cost an afternoon.
    console.log(describeMailTransport());

    // The two services the system raises for itself. Without these rows in the
    // catalogue they never appear in a client's rate card, so no dispatch and no
    // FBA consignment can be priced — which is exactly what had happened: both
    // helpers existed and neither was ever called. Idempotent, so every worker
    // and every restart is safe.
    await ensureShipmentService();
    await ensureFbaService();
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
