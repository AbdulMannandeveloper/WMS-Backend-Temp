/**
 * Dispatch: the point at which goods leave, stock moves, and the client is billed.
 *
 * This began in test/known-bugs/ describing a dispatch that could never succeed.
 * repositories/shipment_service_mapping.repository.js read
 * `prisma.shipmentServiceMapping`, a model that existed in no schema, no
 * migration and not in the generated client, and shipment.logic.js called it
 * *inside* the dispatch transaction — so every dispatch died on
 * "Cannot read properties of undefined (reading 'findMany')" and rolled back.
 *
 * Chunk 1.3 added the model and repaired the transaction. This is now the
 * regression suite for the whole outbound path.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
  makeService,
  makeClientService,
  makeInvoice,
} from '../factories/index.js';

/**
 * A shipment at READY_FOR_DISPATCH with 10 units reserved in one bin.
 *
 * The client's fixedShipmentRate is zeroed so these tests see only the service
 * charges they are about. The per-shipment rate has its own suite in
 * test/billing/shipment-charge.test.js.
 */
const arrangeReady = async () => {
  const scenario = await makeWarehouseScenario({ quantity: 100 });
  const { employee, client, product, location, stock } = scenario;

  await prisma.client.update({
    where: { id: client.id },
    data: { fixedShipmentRate: '0.00' },
  });

  const shipment = await makeShipment(employee.id, client.id, {
    status: 'READY_FOR_DISPATCH',
  });
  await makeShipmentItem(shipment.id, product.id, location.id, {
    quantity: 10,
    status: 'PICKED',
  });
  await prisma.stockLevel.update({
    where: { id: stock.id },
    data: { reservedQuantity: 10 },
  });

  return { ...scenario, shipment };
};

/** Attaches a billable service at an agreed rate, returning the mapping. */
const attachService = async (shipment, clientId, { chargedPrice = '3.00', quantity = 2 } = {}) => {
  const service = await makeService({ description: 'Pallet wrapping' });
  const clientService = await makeClientService(clientId, service.id, { chargedPrice });

  const mapping = await prisma.shipmentServiceMapping.create({
    data: {
      shipmentId: shipment.id,
      serviceId: service.id,
      clientServiceId: clientService.id,
      quantity,
      appliedUnitPrice: chargedPrice,
    },
  });

  return { service, clientService, mapping };
};

describe('dispatch', () => {
  it('succeeds for a ready shipment', async () => {
    const { admin, shipment } = await arrangeReady();

    const res = await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    expect(res.status).toBe(200);
  });

  it('moves the shipment to DISPATCHED', async () => {
    const { admin, shipment } = await arrangeReady();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const after = await prisma.shipment.findUnique({ where: { id: shipment.id } });
    expect(after.status).toBe('DISPATCHED');
  });

  it('deducts physical stock from the source bin', async () => {
    const { admin, shipment, stock } = await arrangeReady();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const after = await prisma.stockLevel.findUnique({ where: { id: stock.id } });
    expect(after.currentQuantity).toBe(90);
    expect(after.reservedQuantity).toBe(0);
  });

  it('writes a CHECKOUT row to the inventory ledger', async () => {
    const { admin, shipment, product, employeeUser } = await arrangeReady();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const ledger = await prisma.inventoryLedger.findMany({
      where: { referenceId: shipment.id },
    });

    expect(ledger).toHaveLength(1);
    expect(ledger[0].movementType).toBe('CHECKOUT');
    expect(ledger[0].productId).toBe(product.id);
    expect(ledger[0].quantity).toBe(10);
    // A User id, not an Employee id — the old fallback would have written the latter.
    expect(ledger[0].userId).toBe(employeeUser.id);
  });

  it('records the dispatch in the audit trail', async () => {
    const { admin, shipment } = await arrangeReady();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'SHIPMENT_DISPATCHED' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(admin.id);
  });

  describe('billing', () => {
    it('raises an invoice line per attached service', async () => {
      const { admin, shipment, client } = await arrangeReady();
      await attachService(shipment, client.id, { chargedPrice: '3.00', quantity: 2 });

      await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      const invoices = await prisma.monthlyInvoice.findMany({
        where: { clientId: client.id },
        include: { lineItems: true },
      });

      expect(invoices).toHaveLength(1);
      expect(invoices[0].status).toBe('DRAFT');
      expect(invoices[0].lineItems).toHaveLength(1);
      expect(Number(invoices[0].lineItems[0].totalPrice)).toBe(6);
    });

    it('keeps the invoice total equal to the sum of its lines', async () => {
      const { admin, shipment, client } = await arrangeReady();
      await attachService(shipment, client.id, { chargedPrice: '3.00', quantity: 2 });

      await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      const invoice = await prisma.monthlyInvoice.findFirst({
        where: { clientId: client.id },
        include: { lineItems: true },
      });
      const sum = invoice.lineItems.reduce((a, l) => a + Number(l.totalPrice), 0);

      expect(Number(invoice.totalAmount)).toBe(sum);
      expect(Number(invoice.totalAmount)).toBe(6);
    });

    it('bills the frozen price, not the current rate', async () => {
      const { admin, shipment, client } = await arrangeReady();
      const { clientService } = await attachService(shipment, client.id, {
        chargedPrice: '3.00',
        quantity: 2,
      });

      // The client renegotiates upward after the service was attached.
      await prisma.clientService.update({
        where: { id: clientService.id },
        data: { chargedPrice: '99.00' },
      });

      await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      const invoice = await prisma.monthlyInvoice.findFirst({
        where: { clientId: client.id },
        include: { lineItems: true },
      });

      // Still 2 x 3.00 — the rate agreed when the work was booked.
      expect(Number(invoice.lineItems[0].totalPrice)).toBe(6);
    });

    it('opens no invoice when the shipment has no billable services', async () => {
      const { admin, shipment, client } = await arrangeReady();

      await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      // The goods still moved; there was simply nothing to charge.
      await expect(
        prisma.monthlyInvoice.count({ where: { clientId: client.id } })
      ).resolves.toBe(0);
    });

    it('rolls the charge forward when this month is already closed', async () => {
      const { admin, shipment, client } = await arrangeReady();
      await attachService(shipment, client.id, { chargedPrice: '3.00', quantity: 2 });

      const now = new Date();
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await makeInvoice(client.id, {
        billingPeriod: thisMonth,
        status: 'APPROVED',
        totalAmount: '500.00',
      });

      const res = await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      // Dispatch is not blocked by a closed accounting period...
      expect(res.status).toBe(200);

      const invoices = await prisma.monthlyInvoice.findMany({
        where: { clientId: client.id },
        include: { lineItems: true },
        orderBy: { billingPeriod: 'asc' },
      });

      // ...and the charge is not lost: it lands on the next open period.
      expect(invoices).toHaveLength(2);
      expect(invoices[0].status).toBe('APPROVED');
      expect(invoices[0].lineItems).toHaveLength(0);
      expect(Number(invoices[0].totalAmount)).toBe(500);

      expect(invoices[1].status).toBe('DRAFT');
      expect(invoices[1].lineItems).toHaveLength(1);
      expect(Number(invoices[1].totalAmount)).toBe(6);
    });
  });

  describe('atomicity', () => {
    it('rolls everything back if the stock is gone underneath it', async () => {
      const { admin, shipment, stock } = await arrangeReady();

      // Someone else empties the bin between picking and dispatch.
      await prisma.stockLevel.update({
        where: { id: stock.id },
        data: { currentQuantity: 0, reservedQuantity: 0 },
      });

      const res = await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

      expect(res.status).toBe(400);

      const after = await prisma.shipment.findUnique({ where: { id: shipment.id } });
      const ledger = await prisma.inventoryLedger.count({
        where: { referenceId: shipment.id },
      });

      // Status, ledger and invoice all move together or not at all.
      expect(after.status).toBe('READY_FOR_DISPATCH');
      expect(ledger).toBe(0);
    });
  });
});
