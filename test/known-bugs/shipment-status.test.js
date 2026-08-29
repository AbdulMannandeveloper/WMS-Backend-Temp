/**
 * A3 — the shipment workflow is enforced only in the browser.
 *
 * SHIPMENT_UPDATE_FIELDS (controllers/shipment.controller.js:14) includes
 * `status`, and logic/shipment.logic.js:178 passes it straight to the
 * repository with no validation. The pick -> pack -> ready -> dispatch sequence
 * lives entirely in src/pages/shipments/index.tsx, so any employee can PUT a
 * shipment directly to DISPATCHED and skip the stock deduction, the ledger and
 * the billing that the real dispatch endpoint performs.
 *
 * `status` is also free text rather than an enum, so arbitrary values stick.
 *
 * Fixed by chunk 1.2 (Prisma enums + a server-side transition map, with status
 * removed from the generic update route).
 *
 * Written with `it.fails` — see invoice-total.test.js for the rationale.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeWarehouseScenario, makeShipment } from '../factories/index.js';

const arrangePendingShipment = async () => {
  const scenario = await makeWarehouseScenario();
  const shipment = await makeShipment(scenario.employee.id, scenario.client.id, {
    status: 'PENDING',
  });
  return { ...scenario, shipment };
};

describe('A3 — shipment status transitions', () => {
  it.fails('an employee cannot jump a PENDING shipment straight to DISPATCHED', async () => {
    const { employeeUser, shipment } = await arrangePendingShipment();

    const res = await as(employeeUser)
      .put(`/api/shipments/${shipment.id}`)
      .send({ status: 'DISPATCHED' });

    // Today: 200, and the shipment is "dispatched" with stock untouched.
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await prisma.shipment.findUnique({ where: { id: shipment.id } });
    expect(after.status).toBe('PENDING');
  });

  it.fails('skipping to DISPATCHED does not silently bypass stock deduction', async () => {
    const { employeeUser, shipment, stock } = await arrangePendingShipment();

    await as(employeeUser)
      .put(`/api/shipments/${shipment.id}`)
      .send({ status: 'DISPATCHED' });

    const [after, ledger] = await Promise.all([
      prisma.shipment.findUnique({ where: { id: shipment.id } }),
      prisma.inventoryLedger.findMany({ where: { referenceId: shipment.id } }),
    ]);

    // The real damage: a shipment marked DISPATCHED with no ledger entry and
    // full stock still on the shelf. Books and shelves disagree from here on.
    expect(
      after.status === 'DISPATCHED' && ledger.length === 0,
      'shipment reached DISPATCHED without an inventory movement'
    ).toBe(false);

    const stockAfter = await prisma.stockLevel.findUnique({ where: { id: stock.id } });
    expect(stockAfter.currentQuantity).toBe(100);
  });

  it.fails('an arbitrary status string is rejected', async () => {
    const { employeeUser, shipment } = await arrangePendingShipment();

    const res = await as(employeeUser)
      .put(`/api/shipments/${shipment.id}`)
      .send({ status: 'BANANA' });

    // Today: 200. status is VarChar, not an enum.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it.fails('a dispatched shipment cannot be reverted to PENDING', async () => {
    const { employeeUser, employee, client } = await arrangePendingShipment();
    const dispatched = await makeShipment(employee.id, client.id, {
      status: 'DISPATCHED',
    });

    const res = await as(employeeUser)
      .put(`/api/shipments/${dispatched.id}`)
      .send({ status: 'PENDING' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it.fails('only an admin may change a shipment courier', async () => {
    const { employeeUser, shipment } = await arrangePendingShipment();

    const res = await as(employeeUser)
      .put(`/api/shipments/${shipment.id}`)
      .send({ courierName: 'DPD' });

    // Chunk 1.2 / ask #4: employees advance the pick-pack sequence, but only an
    // admin may edit the commercial and identity fields.
    expect(res.status).toBe(403);
  });
});
