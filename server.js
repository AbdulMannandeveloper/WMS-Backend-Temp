require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { connectDB } = require("./lib/prisma");

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

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Serve static files from public directory
app.use(express.static("public"));

app.get('/', (req, res) => {
	res.status(200).json({
		message: 'ProPackers UK API is running',
		version: '1.0.0',
	});
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

const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();
