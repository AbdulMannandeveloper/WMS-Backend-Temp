require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const pinoHttp = require("pino-http");

const { connectDB, prisma } = require("./lib/prisma");
const { getRedisClient, disconnectRedis } = require("./lib/redis");

const userRoutes = require("./routes/user.routes");
const authRoutes = require("./routes/auth.routes");
const clientRoutes = require("./routes/client.routes");
const serviceRoutes = require("./routes/service.routes");
const clientServiceRoutes = require("./routes/client_service.routes");
const productRoutes = require("./routes/product.routes");
const stockLevelRoutes = require("./routes/stock_level.routes");
const shiftRoutes = require("./routes/shift.routes");
const holidayRoutes = require("./routes/holiday.routes");
const warehouseLocationClassRoutes = require("./routes/warehouse_location_class.routes");
const warehouseLocationRoutes = require("./routes/warehouse_location.routes");
const inventoryLedgerRoutes = require("./routes/inventory_ledger.routes");
const shipmentRoutes = require("./routes/shipment.routes");
const shipmentItemRoutes = require("./routes/shipment_item.routes");
const attendanceRoutes = require("./routes/attendance.routes");
const monthlyInvoiceRoutes = require("./routes/monthly_invoice.routes");
const auditLogRoutes = require("./routes/audit_log.routes");
const payrollRoutes = require("./routes/payroll.routes");
const expenseRoutes = require("./routes/expense.routes");
const profitLossRoutes = require("./routes/profit_loss.routes");

const app = express();
const PORT = process.env.PORT || 5000;
const BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);

let server = null;
let shuttingDown = false;

app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(compression());
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

if (process.env.NODE_ENV === "production") {
  app.use(
    pinoHttp({
      level: process.env.LOG_LEVEL || "info",
      autoLogging: true,
    })
  );
} else {
  app.use(morgan("dev"));
}

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.status(200).json({
    message: "ProPackers UK API is running",
    version: "1.0.0",
  });
});

app.get("/healthz", (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ status: "shutting_down" });
  }
  return res.status(200).json({ status: "ok" });
});

app.get("/readyz", async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ status: "shutting_down" });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ status: "ready" });
  } catch (err) {
    return res.status(503).json({ status: "not_ready", error: err.message });
  }
});

app.use("/api/users", userRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/client-services", clientServiceRoutes);
app.use("/api/products", productRoutes);
app.use("/api/stock", stockLevelRoutes);
app.use("/api/shifts", shiftRoutes);
app.use("/api/holidays", holidayRoutes);
app.use("/api/warehouse-location-classes", warehouseLocationClassRoutes);
app.use("/api/warehouse-locations", warehouseLocationRoutes);
app.use("/api/inventory-ledgers", inventoryLedgerRoutes);
app.use("/api/shipments", shipmentRoutes);
app.use("/api/shipment-items", shipmentItemRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/monthly-invoices", monthlyInvoiceRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/profit-loss", profitLossRoutes);

app.use((req, res) => {
  res.status(404).json({
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    message: "Internal server error",
  });
});

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
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
