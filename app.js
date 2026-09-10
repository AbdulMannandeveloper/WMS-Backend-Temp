'use strict';

/**
 * Builds and exports the configured Express app.
 *
 * Deliberately free of side effects: no dotenv load, no database connection,
 * no Redis connection, no listener. That keeps the app importable from tests
 * (see test/helpers) without booting real infrastructure. All of that lives in
 * server.js, which is still the process entry point.
 */

const fs = require("node:fs");
const path = require("node:path");

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
const fbaRoutes = require("./routes/fba.routes");
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

/**
 * The built front end, when this service is serving it as well as the API.
 *
 * Same origin is the point. Split across two hosts the session refresh cookie
 * is third-party, and iOS Safari, Firefox and every private window drop it
 * outright — the user signs in, the cookie never lands, and the next request
 * bounces them back to the login screen. Served from here it is an ordinary
 * first-party cookie and the problem does not exist.
 *
 * Optional, and detected rather than configured: with no build present this
 * stays a pure API, which is what the tests and any API-only deployment want.
 * deploy/nginx.conf does the same job for the container stack.
 */
// Resolved, because sendFile refuses a relative path and FRONTEND_DIST is
// whatever a deployment happened to type.
const FRONTEND_DIST = path.resolve(
  process.env.FRONTEND_DIST || path.join(__dirname, "client"),
);
const FRONTEND_INDEX = path.join(FRONTEND_DIST, "index.html");
const servingFrontend = fs.existsSync(FRONTEND_INDEX);

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

/**
 * Who may call this API from a browser.
 *
 * Two things here were wrong in ways that only showed up once the app started
 * being served from this same service:
 *
 * 1. **A same-origin request was being refused.** Browsers attach an Origin
 *    header to same-origin POSTs as well as cross-origin ones, so once the app
 *    is served from here, every call arrives carrying this service's own
 *    origin — which is not in CORS_ORIGINS and never would be, because nobody
 *    thinks to list themselves. Comparing against the host the request actually
 *    came in on settles it without configuration, and keeps working when the
 *    domain changes.
 *
 * 2. **A refusal threw.** `callback(new Error(...))` becomes an unhandled error,
 *    which the handler at the bottom of this file turns into a 500 — so a
 *    disallowed origin looked like the server falling over, and filled the log
 *    with stack traces. Answering `origin: false` is what the refusal should
 *    be: the CORS headers are simply not sent, and the browser does the
 *    enforcing, which is where that enforcement has to live anyway.
 *
 * The delegate form is used rather than the plain options object because only
 * it gets `req`, and the host is the whole point.
 */
app.use(
  cors((req, callback) => {
    const origin = req.header("Origin");
    const ownOrigin = `${req.protocol}://${req.get("host")}`;

    callback(null, {
      origin: !origin || origin === ownOrigin || allowedOrigins.includes(origin),
      credentials: true,
    });
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

// The front end's own files. `index: false` because the fallback below decides
// when index.html is the answer — letting static serve it for "/" only would
// leave every deeper route to 404.
if (servingFrontend) {
  app.use(
    express.static(FRONTEND_DIST, {
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything under assets/, so those are safe to keep
        // forever. index.html must not be cached at all: a stale one points at
        // asset filenames that no longer exist after a deploy, and the app
        // fails to boot with nothing on screen to explain it.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    }),
  );
}

// Scoped to /api, which is what keeps /healthz and /readyz out of it — an
// orchestrator polling health must never be throttled. Mount order is
// irrelevant here; the path is doing the work.
app.use("/api", globalLimiter());

// Where the API says hello. On an API-only deployment that is the root; when
// this service also serves the app, the root belongs to the app and the banner
// moves out of its way.
app.get(servingFrontend ? "/api" : "/", (req, res) => {
  res.status(200).json({
    message: "Pro Packers UK API is running",
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
app.use("/api/fba-shipments", fbaRoutes);
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

/**
 * Client-side routes.
 *
 * /app/inventory is not a file, so the server has to hand back index.html and
 * let react-router work out the rest. Without this a refresh or a bookmarked
 * link returns 404 — or, worse, a blank page.
 *
 * Two things it deliberately does not catch:
 *
 *  - anything under /api, which must keep answering JSON. An unknown API path
 *    returning an HTML page turns a clear 404 into "Unexpected token '<'" in
 *    the caller, which is a much longer afternoon.
 *  - anything that is not a GET. A POST to a path that does not exist is a
 *    mistake worth reporting, not a page navigation.
 */
if (servingFrontend) {
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    // A request that explicitly wants JSON is a client calling an endpoint that
    // is not there, whatever the path looks like.
    if (req.accepts("html")) {
      // Set here rather than in the static handler above: with `index: false`
      // this fallback is the only thing that ever serves index.html, so it is
      // the only place the header can be attached.
      return res.sendFile(FRONTEND_INDEX, {
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
    }
    return next();
  });
}

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
