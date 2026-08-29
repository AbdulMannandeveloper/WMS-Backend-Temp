/**
 * A1 — dispatch can never succeed.
 *
 * repositories/shipment_service_mapping.repository.js:3 reads
 * `prisma.shipmentServiceMapping`, but no ShipmentServiceMapping model exists
 * in schema.prisma, no migration creates the table, and it is absent from the
 * generated client. logic/shipment.logic.js:130 calls into it *inside* the
 * dispatch transaction, so the TypeError rolls the whole thing back: status
 * never flips, stock is never deducted, no ledger row, no invoice line.
 *
 * Fixed by chunk 1.3 (create the model + migration, thread `tx` through).
 *
 * Written with `it.fails` — see invoice-total.test.js for the rationale.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
} from '../factories/index.js';

/** A shipment sitting at READY_FOR_DISPATCH with 10 units reserved in one bin. */
const arrangeReadyShipment = async () => {
  const scenario = await makeWarehouseScenario({ quantity: 100 });
  const { employee, client, product, location, stock } = scenario;

  const shipment = await makeShipment(employee.id, client.id, {
    status: 'READY_FOR_DISPATCH',
  });

  await makeShipmentItem(shipment.id, product.id, location.id, {
    quantity: 10,
    status: 'PICKED',
  });

  // Mirror what createShipmentItem would have reserved.
  await prisma.stockLevel.update({
    where: { id: stock.id },
    data: { reservedQuantity: 10 },
  });

  return { ...scenario, shipment };
};

describe('A1 — shipment dispatch', () => {
  it.fails('dispatching a ready shipment succeeds', async () => {
    const { admin, shipment } = await arrangeReadyShipment();

    const res = await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    // Today: 400 — "Cannot read properties of undefined (reading 'findMany')".
    expect(res.status).toBe(200);
  });

  it.fails('dispatch deducts physical stock from the source bin', async () => {
    const { admin, shipment, stock } = await arrangeReadyShipment();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const after = await prisma.stockLevel.findUnique({ where: { id: stock.id } });

    expect(after.currentQuantity).toBe(90);
    expect(after.reservedQuantity).toBe(0);
  });

  it.fails('dispatch writes a CHECKOUT row to the inventory ledger', async () => {
    const { admin, shipment, product } = await arrangeReadyShipment();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const ledger = await prisma.inventoryLedger.findMany({
      where: { referenceId: shipment.id },
    });

    expect(ledger).toHaveLength(1);
    expect(ledger[0].movementType).toBe('CHECKOUT');
    expect(ledger[0].productId).toBe(product.id);
    expect(ledger[0].quantity).toBe(10);
  });

  it.fails('dispatch moves the shipment to DISPATCHED', async () => {
    const { admin, shipment } = await arrangeReadyShipment();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const after = await prisma.shipment.findUnique({ where: { id: shipment.id } });

    expect(after.status).toBe('DISPATCHED');
  });

  it.fails('dispatch opens a draft invoice for the client', async () => {
    const { admin, shipment, client } = await arrangeReadyShipment();

    await as(admin).post(`/api/shipments/${shipment.id}/dispatch`);

    const invoices = await prisma.monthlyInvoice.findMany({
      where: { clientId: client.id },
    });

    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('DRAFT');
  });
});
