/**
 * Shipment lifecycle.
 *
 * These began in test/known-bugs/ describing the opposite behaviour: the
 * pick → ready → dispatch sequence lived only in the React page, so any employee
 * could PUT a shipment straight to DISPATCHED — skipping the stock deduction,
 * the ledger entry and the billing — or set the status to the literal string
 * BANANA, because it was unvalidated free text.
 *
 * Chunk 1.2 made status a Postgres enum and moved the state machine into
 * logic/shipment.logic.js. These are now the regression suite guarding it.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
} from '../factories/index.js';

const arrange = async (overrides = {}) => {
  const scenario = await makeWarehouseScenario();
  const shipment = await makeShipment(
    scenario.employee.id,
    scenario.client.id,
    overrides
  );
  return { ...scenario, shipment };
};

/** A PENDING shipment carrying one unpicked line. */
const arrangeWithItem = async (overrides = {}) => {
  const ctx = await arrange(overrides);
  const item = await makeShipmentItem(
    ctx.shipment.id,
    ctx.product.id,
    ctx.location.id,
    { quantity: 10 }
  );
  await prisma.stockLevel.update({
    where: { id: ctx.stock.id },
    data: { reservedQuantity: 10 },
  });
  return { ...ctx, item };
};

const statusOf = async (id) =>
  (await prisma.shipment.findUnique({ where: { id } })).status;

describe('shipment lifecycle', () => {
  describe('the sequence', () => {
    it('runs PENDING → picked → READY_FOR_DISPATCH', async () => {
      const { employeeUser, shipment, item } = await arrangeWithItem();

      const picked = await as(employeeUser).put(
        `/api/shipment-items/${item.id}/pick`
      );
      expect(picked.status).toBe(200);

      const ready = await as(employeeUser).post(
        `/api/shipments/${shipment.id}/ready`
      );
      expect(ready.status).toBe(200);
      await expect(statusOf(shipment.id)).resolves.toBe('READY_FOR_DISPATCH');
    });

    it('refuses to mark ready while an item is unpicked', async () => {
      const { employeeUser, shipment } = await arrangeWithItem();

      const res = await as(employeeUser).post(
        `/api/shipments/${shipment.id}/ready`
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not been picked/i);
      await expect(statusOf(shipment.id)).resolves.toBe('PENDING');
    });

    it('refuses to mark ready with no items at all', async () => {
      const { employeeUser, shipment } = await arrange();

      const res = await as(employeeUser).post(
        `/api/shipments/${shipment.id}/ready`
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no items/i);
    });

    it('lets an admin reopen a shipment marked ready by mistake', async () => {
      const { admin, employeeUser, shipment, item } = await arrangeWithItem();
      await as(employeeUser).put(`/api/shipment-items/${item.id}/pick`);
      await as(employeeUser).post(`/api/shipments/${shipment.id}/ready`);

      const res = await as(admin).post(`/api/shipments/${shipment.id}/reopen`);

      expect(res.status).toBe(200);
      await expect(statusOf(shipment.id)).resolves.toBe('PENDING');
    });

    it('unpicks an item back to PENDING', async () => {
      const { employeeUser, item } = await arrangeWithItem();
      await as(employeeUser).put(`/api/shipment-items/${item.id}/pick`);

      const res = await as(employeeUser).put(
        `/api/shipment-items/${item.id}/unpick`
      );

      expect(res.status).toBe(200);
      const after = await prisma.shipmentItem.findUnique({ where: { id: item.id } });
      expect(after.status).toBe('PENDING');
    });

    it('refuses to pick an item once the shipment has left PENDING', async () => {
      const { employeeUser, shipment, item } = await arrangeWithItem();
      await as(employeeUser).put(`/api/shipment-items/${item.id}/pick`);
      await as(employeeUser).post(`/api/shipments/${shipment.id}/ready`);

      const res = await as(employeeUser).put(
        `/api/shipment-items/${item.id}/unpick`
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/READY_FOR_DISPATCH/);
    });
  });

  describe('illegal transitions', () => {
    it('an employee cannot jump a PENDING shipment straight to DISPATCHED', async () => {
      const { employeeUser, shipment } = await arrange();

      const res = await as(employeeUser)
        .put(`/api/shipments/${shipment.id}`)
        .send({ status: 'DISPATCHED' });

      // Admin-only route now; an employee never reaches the handler.
      expect(res.status).toBe(403);
      await expect(statusOf(shipment.id)).resolves.toBe('PENDING');
    });

    it('not even an admin can set status through the update endpoint', async () => {
      const { admin, shipment } = await arrange();

      const res = await as(admin)
        .put(`/api/shipments/${shipment.id}`)
        .send({ status: 'DISPATCHED' });

      // pick() drops the field, so nothing changes and nothing is dispatched.
      expect(res.status).toBe(200);
      await expect(statusOf(shipment.id)).resolves.toBe('PENDING');
    });

    it('an arbitrary status string never reaches the database', async () => {
      const { admin, shipment } = await arrange();

      await as(admin)
        .put(`/api/shipments/${shipment.id}`)
        .send({ status: 'BANANA' });

      await expect(statusOf(shipment.id)).resolves.toBe('PENDING');
    });

    it('dispatching a PENDING shipment is refused', async () => {
      const { employeeUser, shipment } = await arrangeWithItem();

      const res = await as(employeeUser).post(
        `/api/shipments/${shipment.id}/dispatch`
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot become DISPATCHED/i);
    });

    it('a dispatched shipment cannot be reopened or cancelled', async () => {
      const { admin, employee, client } = await arrange();
      const dispatched = await makeShipment(employee.id, client.id, {
        status: 'DISPATCHED',
      });

      const reopened = await as(admin).post(`/api/shipments/${dispatched.id}/reopen`);
      const cancelled = await as(admin).post(`/api/shipments/${dispatched.id}/cancel`);

      expect(reopened.status).toBe(400);
      expect(cancelled.status).toBe(400);
      expect(cancelled.body.error).toMatch(/final state/i);
      await expect(statusOf(dispatched.id)).resolves.toBe('DISPATCHED');
    });

    it('a cancelled shipment is terminal', async () => {
      const { admin, employee, client } = await arrange();
      const cancelled = await makeShipment(employee.id, client.id, {
        status: 'CANCELLED',
      });

      const ready = await as(admin).post(`/api/shipments/${cancelled.id}/ready`);

      expect(ready.status).toBe(400);
      await expect(statusOf(cancelled.id)).resolves.toBe('CANCELLED');
    });
  });

  describe('who may do what', () => {
    it('an employee cannot change the courier', async () => {
      const { employeeUser, shipment } = await arrange();

      const res = await as(employeeUser)
        .put(`/api/shipments/${shipment.id}`)
        .send({ courierName: 'DPD' });

      expect(res.status).toBe(403);
    });

    it('an admin can change the courier', async () => {
      const { admin, shipment } = await arrange();

      const res = await as(admin)
        .put(`/api/shipments/${shipment.id}`)
        .send({ courierName: 'DPD' });

      expect(res.status).toBe(200);
      const after = await prisma.shipment.findUnique({ where: { id: shipment.id } });
      expect(after.courierName).toBe('DPD');
    });

    it('ignores a tracking id sent to the generic update', async () => {
      // It used to be settable here. It moved to PUT /:id/tracking, which staff
      // may also use and which stays open after dispatch — see
      // test/shipments/tracking.test.js. Silently dropped rather than rejected,
      // the same way every other unknown field on this endpoint is.
      const { admin, shipment } = await arrange();

      const res = await as(admin)
        .put(`/api/shipments/${shipment.id}`)
        .send({ courierName: 'DPD', trackingId: 'H00CXH0012345678' });

      expect(res.status).toBe(200);
      const after = await prisma.shipment.findUnique({ where: { id: shipment.id } });
      expect(after.courierName).toBe('DPD');
      expect(after.trackingId).toBeNull();
    });

    it('an employee cannot cancel, reopen or delete', async () => {
      const { employeeUser, shipment } = await arrange();

      for (const call of [
        as(employeeUser).post(`/api/shipments/${shipment.id}/cancel`),
        as(employeeUser).post(`/api/shipments/${shipment.id}/reopen`),
        as(employeeUser).delete(`/api/shipments/${shipment.id}`),
      ]) {
        await expect(call.then((r) => r.status)).resolves.toBe(403);
      }
    });

    it('a dispatched shipment can no longer be edited', async () => {
      const { admin, employee, client } = await arrange();
      const dispatched = await makeShipment(employee.id, client.id, {
        status: 'DISPATCHED',
      });

      const res = await as(admin)
        .put(`/api/shipments/${dispatched.id}`)
        .send({ courierName: 'DPD' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no longer be edited/i);
    });
  });

  describe('cancel and delete', () => {
    it('cancelling hands the reserved stock back', async () => {
      const { admin, shipment, stock } = await arrangeWithItem();

      const res = await as(admin).post(`/api/shipments/${shipment.id}/cancel`);

      expect(res.status).toBe(200);
      await expect(statusOf(shipment.id)).resolves.toBe('CANCELLED');

      const after = await prisma.stockLevel.findUnique({ where: { id: stock.id } });
      expect(after.reservedQuantity).toBe(0);
      expect(after.currentQuantity).toBe(100);
    });

    it('refuses to delete a dispatched shipment', async () => {
      const { admin, employee, client } = await arrange();
      const dispatched = await makeShipment(employee.id, client.id, {
        status: 'DISPATCHED',
      });

      const res = await as(admin).delete(`/api/shipments/${dispatched.id}`);

      // Deleting it would orphan the inventory_ledger rows that reference it.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot be deleted/i);
      await expect(
        prisma.shipment.count({ where: { id: dispatched.id } })
      ).resolves.toBe(1);
    });

    it('still deletes a pending shipment and releases its stock', async () => {
      const { admin, shipment, stock } = await arrangeWithItem();

      const res = await as(admin).delete(`/api/shipments/${shipment.id}`);

      expect(res.status).toBe(200);
      const after = await prisma.stockLevel.findUnique({ where: { id: stock.id } });
      expect(after.reservedQuantity).toBe(0);
    });
  });

  describe('audit trail', () => {
    it('records each transition against the user who made it', async () => {
      const { admin, employeeUser, shipment, item } = await arrangeWithItem();

      await as(employeeUser).put(`/api/shipment-items/${item.id}/pick`);
      await as(employeeUser).post(`/api/shipments/${shipment.id}/ready`);
      await as(admin).post(`/api/shipments/${shipment.id}/reopen`);

      const logs = await prisma.auditLog.findMany({ orderBy: { timestamp: 'asc' } });
      const actions = logs.map((l) => l.action);

      expect(actions).toEqual([
        'SHIPMENT_ITEM_PICKED',
        'SHIPMENT_READY',
        'SHIPMENT_REOPENED',
      ]);
      expect(logs[0].userId).toBe(employeeUser.id);
      expect(logs[2].userId).toBe(admin.id);
      expect(JSON.parse(logs[1].details).shipmentId).toBe(shipment.id);
    });
  });
});
