const { prisma } = require("../lib/prisma");
const shipmentRepositry = require("../repositories/shipment.repository");
const stockLevelRepository = require("../repositories/stock_level.repository");
const monthlyInvoiceRepository = require("../repositories/monthly_invoice.repository");
const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const shipmentItemLogic = require("./shipment_item.logic");
const employeeLogic = require("./employee.logic");
const clientLogic = require("./client.logic");
const inventoryLedgerLogic = require("./inventory_ledger.logic");
const ShipmentServiceMappingLogic = require("./shipment_service_mapping.logic");
const clientServiceLogic = require("./client_service.logic");

const createShipment = async (data) => {
  if (!data.employeeId || !data.clientId || !data.shipmentType) {
    throw new Error(
      "Employee ID, Client ID, and Shipment Type are required to create a shipment.",
    );
  }

  const employee = await employeeLogic.getEmployeeById(data.employeeId);
  const client = await clientLogic.getClientById(data.clientId);
  if (!employee) {
    throw new Error("Employee not found.");
  }
  if (!client) {
    throw new Error("Client not found.");
  }

  if (!data.status) {
    data.status = "PENDING";
  }

  const { shipmentItems, shipmentServices, ...shipmentData } = data;
  const shipment = await shipmentRepositry.createShipment(shipmentData);

  if (data.shipmentItems && Array.isArray(data.shipmentItems)) {
    for (const item of data.shipmentItems) {
      item.shipmentId = shipment.id;
      await shipmentItemLogic.createShipmentItem(item);
    }
  }
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

/**
 * Dispatch a shipment: status flip + inventory checkouts + invoice lines
 * all commit or roll back together.
 */
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

  return prisma.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { status: "DISPATCHED" },
    });

    const shipmentItems = await tx.shipmentItem.findMany({
      where: { shipmentId },
    });

    const actorUserId =
      shipment.employee?.userId ||
      shipment.employee?.user?.id ||
      shipment.employeeId;

    for (const item of shipmentItems) {
      await inventoryLedgerLogic.createInventoryLedger(
        {
          productId: item.productId,
          userId: actorUserId,
          movementType: "CHECKOUT",
          quantity: item.quantity,
          referenceId: shipment.id,
          fromLocationId: item.sourceLocationId,
        },
        { tx },
      );
    }

    const billingMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );

    let monthlyInvoice =
      await monthlyInvoiceRepository.getMonthlyInvoiceByClientIdAndMonth(
        shipment.clientId,
        billingMonth,
        tx,
      );
    if (!monthlyInvoice) {
      monthlyInvoice = await monthlyInvoiceRepository.createMonthlyInvoice(
        {
          clientId: shipment.clientId,
          billingPeriod: billingMonth,
          status: "DRAFT",
        },
        tx,
      );
    }

    const shipmentServices =
      await ShipmentServiceMappingLogic.getShipmentServiceMappingsByField(
        "shipmentId",
        shipmentId,
      );

    let totalAdjust = 0;
    for (const serviceMapping of shipmentServices) {
      const clientService =
        await clientServiceLogic.getClientServiceByClientIdAndServiceId(
          shipment.clientId,
          serviceMapping.serviceId,
        );

      const unitPrice = serviceMapping.appliedUnitPrice;
      const quantity = serviceMapping.quantity;
      const totalPrice = quantity * unitPrice;

      await invoiceLineItemRepository.createInvoiceLineItem(
        {
          invoiceId: monthlyInvoice.id,
          clientServiceId: clientService ? clientService.id : null,
          quantity,
          unitPrice,
          totalPrice,
          description: `Charge for service "${serviceMapping.service?.description || serviceMapping.serviceId}" on shipment ${shipment.id}`,
          dateOfService: new Date(),
          itemType: "AUTOMATED_SERVICE",
        },
        tx,
      );
      totalAdjust += totalPrice;
    }

    if (totalAdjust !== 0) {
      await monthlyInvoiceRepository.updateMonthlyInvoice(
        monthlyInvoice.id,
        { totalAmount: Number(monthlyInvoice.totalAmount || 0) + totalAdjust },
        tx,
      );
    }

    return await shipmentRepositry.getShipmentByField("id", shipmentId, tx);
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });
};

const updateShipment = async (id, data) => {
  return await shipmentRepositry.updateShipment(id, data);
};

const deleteShipment = async (id) => {
  const shipment = await shipmentRepositry.getShipmentByField("id", id);
  if (!shipment) {
    throw new Error("Shipment not found.");
  }

  return prisma.$transaction(async (tx) => {
    if (shipment.status !== "DISPATCHED") {
      const shipmentItems = await tx.shipmentItem.findMany({
        where: { shipmentId: id },
      });
      for (const item of shipmentItems) {
        const sourceStock =
          await stockLevelRepository.getStockLevelByProductAndLocation(
            item.productId,
            item.sourceLocationId,
            tx,
          );
        if (sourceStock) {
          await stockLevelRepository.releaseReservedStockAtomically(
            sourceStock.id,
            item.quantity,
            tx,
          );
        }
      }
    }

    return await shipmentRepositry.deleteShipment(id, tx);
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });
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
