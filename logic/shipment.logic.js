const shipmentRepositry = require("../repositories/shipment.repository");

const shipmentItemLogic = require("./shipment_item.logic");
const employeeLogic = require("./employee.logic");
const clientLogic = require("./client.logic");
const stockLevelLogic = require("./stock_level.logic");
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const ShipmentServiceMappingLogic = require("./shipment_service_mapping.logic");
const clientServiceLogic = require("./client_service.logic");
const invoiceLineItemLogic = require("./invoice_line_item.logic");
const monthlyInvoiceLogic = require("./monthly_invoice.logic");

const createShipment = async (data) => {
  // Check for required fields
  if (!data.employeeId || !data.clientId || !data.shipmentType) {
    throw new Error(
      "Employee ID, Client ID, and Shipment Type are required to create a shipment.",
    );
  }

  // Validate employeeId and clientId
  const employee = await employeeLogic.getEmployeeById(data.employeeId);
  const client = await clientLogic.getClientById(data.clientId);
  if (!employee) {
    throw new Error("Employee not found.");
  }
  if (!client) {
    throw new Error("Client not found.");
  }

  if (!data.status) {
    data.status = "PENDING"; // Default status
  }

  const { shipmentItems, shipmentServices, ...shipmentData } = data;
  const shipment = await shipmentRepositry.createShipment(shipmentData);

  // Handle the creation of ShipmentItems if provided
  if (data.shipmentItems && Array.isArray(data.shipmentItems)) {
    for (const item of data.shipmentItems) {
      item.shipmentId = shipment.id; // Associate the item with the created shipment
      await shipmentItemLogic.createShipmentItem(item);
    }
  }
  // Return the shipment combined with its created items
  const createdShipmentItems = await shipmentItemLogic.getShipmentItemsByField(
    "shipmentId",
    shipment.id,
  );
  return { ...shipment, shipmentItems: createdShipmentItems };
};

const getAllShipments = async () => {
  return await shipmentRepositry.getAllShipments();
};

const getShipmentByField = async (field, value) => {
  return await shipmentRepositry.getShipmentByField(field, value);
};

const getShipmentsByClientId = async (clientId) => {
  return await shipmentRepositry.getShipmentsByClientId(clientId);
};

const dispatchShipment = async (shipmentId) => {
  const shipment = await shipmentRepositry.getShipmentByField("id", shipmentId);
  if (!shipment) {
    throw new Error("Shipment not found.");
  }
  if (shipment.status !== "READY_FOR_DISPATCH") {
    throw new Error(
      "Only shipments with READY_FOR_DISPATCH status can be dispatched.",
    );
  }
  // Update the shipment status to 'DISPATCHED'
  await shipmentRepositry.updateShipment(shipmentId, { status: "DISPATCHED" });

  const shipmentItems = await shipmentItemLogic.getShipmentItemsByField(
    "shipmentId",
    shipmentId,
  );

  // ── LOOP 1: Inventory deduction — one ledger entry per physical item ──
  for (const item of shipmentItems) {
    const inventoryLedgerEntry = {
      productId: item.productId,
      userId: shipment.employeeId,
      movementType: "CHECKOUT",
      quantity: item.quantity,
      referenceId: shipment.id,
      fromLocationId: item.sourceLocationId,
    };
    await inventoryLedgerLogic.createInventoryLedger(inventoryLedgerEntry);
  }

  // ── LOOP 2: Invoice line items — once per shipment, not per item ──
  // Get or create the monthly invoice for this client's current billing period
  let monthlyInvoice = await monthlyInvoiceLogic.getMonthlyInvoiceByClientIdForMonth(
    shipment.clientId,
    new Date(),
  );
  if (!monthlyInvoice) {
    monthlyInvoice = await monthlyInvoiceLogic.createMonthlyInvoice({
      clientId: shipment.clientId,
    });
  }

  // Fetch all services associated with this shipment
  const shipmentServices =
    await ShipmentServiceMappingLogic.getShipmentServiceMappingsByField(
      "shipmentId",
      shipmentId,
    );

  for (const serviceMapping of shipmentServices) {
    // Bug #4 fix: look up clientServiceId so the line item has a proper backlink
    const clientService = await clientServiceLogic.getClientServiceByClientIdAndServiceId(
      shipment.clientId,
      serviceMapping.serviceId,
    );

    const invoiceLineItemData = {
      invoiceId: monthlyInvoice.id,           // Bug #3 fix: was monthlyInvoiceId
      clientServiceId: clientService ? clientService.id : null,  // Bug #4 fix
      serviceId: serviceMapping.serviceId,
      quantity: serviceMapping.quantity,
      unitPrice: serviceMapping.appliedUnitPrice,
      description: `Charge for service "${serviceMapping.service?.description || serviceMapping.serviceId}" on shipment ${shipment.id}`,
      dateOfService: new Date(),
      itemType: "AUTOMATED_SERVICE",
    };
    await invoiceLineItemLogic.createInvoiceLineItem(invoiceLineItemData);
  }

  return await shipmentRepositry.getShipmentByField("id", shipmentId);
};

const updateShipment = async (id, data) => {
  return await shipmentRepositry.updateShipment(id, data);
};

const deleteShipment = async (id) => {
  const shipment = await shipmentRepositry.getShipmentByField("id", id);
  if (!shipment) {
    throw new Error("Shipment not found.");
  }

  // Release reserved inventory items if not already dispatched
  if (shipment.status !== "DISPATCHED") {
    const shipmentItems = await shipmentItemLogic.getShipmentItemsByField(
      "shipmentId",
      id,
    );
    for (const item of shipmentItems) {
      const sourceStock = await stockLevelLogic.getStockLevelByProductAndLocation(
        item.productId,
        item.sourceLocationId,
      );
      if (sourceStock) {
        const newReserved = Math.max(0, sourceStock.reservedQuantity - item.quantity);
        await stockLevelLogic.updateStockLevel(sourceStock.id, {
          reservedQuantity: newReserved,
        });
      }
    }
  }

  return await shipmentRepositry.deleteShipment(id);
};


module.exports = {
  createShipment,
  dispatchShipment,
  getAllShipments,
  getShipmentByField,
  getShipmentsByClientId,
  updateShipment,
  deleteShipment,
};
