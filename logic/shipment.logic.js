const shipmentRepositry = require("../repositories/shipment.repository");

const shipmentItemLogic = require("./shipment_item.logic");
const employeeLogic = require("./employee.logic");
const clientLogic = require("./client.logic");
const stockLevelLogic = require("./stock_level.logic");
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const ShipmentServiceMappingLogic = require("./shipment_service_mapping.logic");
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

  // Inventory adjustment logic
  const shipmentItems = await shipmentItemLogic.getShipmentItemsByField(
    "shipmentId",
    shipmentId,
  );

  for (const item of shipmentItems) {
    // Adjust the stock level for the source location using ledger logic to ensure proper tracking of inventory movements
    const inventoryLedgerEntry = {
      productId: item.productId,
      userId: shipment.employeeId, // Assuming the employee is the user making the movement
      movementType: "CHECKOUT",
      quantity: item.quantity,
      referenceId: shipment.id,
      fromLocationId: item.sourceLocationId,
    };
    await inventoryLedgerLogic.createInventoryLedger(inventoryLedgerEntry);

    // Check if monthly invoice exists for the client, if not create one
    let monthlyInvoice;
    monthlyInvoice = await monthlyInvoiceLogic.getMonthlyInvoiceByClientIdForMonth(
      shipment.clientId,
      new Date(),
    );
    if (!monthlyInvoice) {
      monthlyInvoice = await monthlyInvoiceLogic.createMonthlyInvoice({
        clientId: shipment.clientId,
      });
    }
    // Transfer the ShipmentServiceMappings for the shipment to InvoiceLineItems for the associated client's monthly invoice
    const shipmentServices =
      await ShipmentServiceMappingLogic.getShipmentServiceMappingsByField(
        "shipmentId",
        shipmentId,
      );

    for (const serviceMapping of shipmentServices) {
      const invoiceLineItemData = {
        monthlyInvoiceId: monthlyInvoice.id,
        serviceId: serviceMapping.serviceId,
        quantity: serviceMapping.quantity,
        unitPrice: serviceMapping.appliedUnitPrice,
        description: `Charge for service ${serviceMapping.serviceId} on shipment ${shipment.id}`,
      };
      await invoiceLineItemLogic.createInvoiceLineItem(invoiceLineItemData);
    }
  }
  return await shipmentRepositry.getShipmentByField("id", shipmentId); // Return the updated shipment
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
