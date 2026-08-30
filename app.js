'use strict';

/**
 * Builds and exports the configured Express app.
 *
 * Deliberately free of side effects: no dotenv load, no database connection,
 * no Redis connection, no listener. That keeps the app importable from tests
 * (see test/helpers) without booting real infrastructure. All of that lives in
 * server.js, which is still the process entry point.
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const pinoHttp = require("pino-http");

const { prisma } = require("./lib/prisma");
const { globalLimiter } = require("./middlewares/rateLimit");

const userRoutes = require("./routes/user.routes");
const authRoutes = require("./routes/auth.routes");
const clientRoutes = require("./routes/client.routes");
const employeeRoutes = require("./routes/employee.routes");
const fdaRoutes = require("./routes/fda.routes");
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
const BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";

// deploy/nginx.conf sits in front and sets X-Forwarded-For. Without this Express
// reports nginx's address as req.ip for every request, and express-rate-limit
// keys on req.ip — so every user shares one bucket and ten failed logins from
// anybody locks out everybody.
//
// The hop count matters: `true` is refused by express-rate-limit
// (ERR_ERL_PERMISSIVE_TRUST_PROXY) because it lets a client spoof the header and
// sidestep the limiter entirely. One hop, one nginx.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

// Flipped by server.js during graceful shutdown so the probes below start
// failing before the listener actually closes.
let shuttingDown = false;
const setShuttingDown = (value) => {
  shuttingDown = value;
};
const isShuttingDown = () => shuttingDown;

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
// The refresh token arrives as an httpOnly cookie.
app.use(cookieParser());

if (process.env.NODE_ENV === "production") {
  app.use(
    pinoHttp({
      level: process.env.LOG_LEVEL || "info",
      autoLogging: true,
    })
  );
} else if (process.env.NODE_ENV !== "test") {
  // Request logging is noise in test output.
  app.use(morgan("dev"));
}

app.use(express.static("public"));

// Scoped to /api, which is what keeps /healthz and /readyz out of it — an
// orchestrator polling health must never be throttled. Mount order is
// irrelevant here; the path is doing the work.
app.use("/api", globalLimiter());

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
app.use("/api/employees", employeeRoutes);
app.use("/api/fda-shipments", fdaRoutes);
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

module.exports = { app, setShuttingDown, isShuttingDown };
