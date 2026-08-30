/**
 * Courier consignment numbers.
 *
 * The field existed in the schema from chunk 1.2 but nothing could write it: the
 * only way in was PUT /api/shipments/:id, which is admin-only and refuses every
 * edit once a shipment is DISPATCHED. Couriers issue the tracking number when
 * they take the parcel — at dispatch, or after it — so the one status that
 * always has a number to record was the one status that could not record it.
 *
 * PUT /api/shipments/:id/tracking is the way in: open to staff, and closed only
 * on CANCELLED.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeWarehouseScenario, makeShipment } from '../factories/index.js';

const arrange = async (overrides = {}) => {
  const scenario = await makeWarehouseScenario();
  const shipment = await makeShipment(
    scenario.employee.id,
    scenario.client.id,
    overrides
  );
  return { ...scenario, shipment };
};

const trackingOf = (id) =>
  prisma.shipment.findUnique({ where: { id }, select: { trackingId: true } });

describe('recording a tracking number', () => {
  it('is allowed on a DISPATCHED shipment — the case that was impossible', async () => {
    // The whole reason this endpoint exists.
    const { shipment, admin } = await arrange({ status: 'DISPATCHED' });

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'H01AA0123456789' });

    expect(res.status).toBe(200);
    await expect(trackingOf(shipment.id)).resolves.toEqual({
      trackingId: 'H01AA0123456789',
    });
  });

  it('refuses the same edit through the generic update, which stays frozen', async () => {
    // Proving the two paths are genuinely separate, not that one replaced the
    // other: everything else about a dispatched shipment is still immutable.
    const { shipment, admin } = await arrange({ status: 'DISPATCHED' });

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}`)
      .send({ courierName: 'Evri' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer be edited/i);
  });

  it('lets an employee record it, not just an admin', async () => {
    // The person handing the parcel over is the one holding the label.
    const { shipment, employeeUser } = await arrange({
      status: 'READY_FOR_DISPATCH',
    });

    const res = await as(employeeUser)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'EV123456789GB' });

    expect(res.status).toBe(200);
    await expect(trackingOf(shipment.id)).resolves.toEqual({
      trackingId: 'EV123456789GB',
    });
  });

  it('works on a PENDING shipment too', async () => {
    const { shipment, admin } = await arrange({ status: 'PENDING' });

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'ABC123' });

    expect(res.status).toBe(200);
  });

  it('strips the spaces couriers print the number in', async () => {
    // Operators copy it off the label exactly as it is printed.
    const { shipment, admin } = await arrange();

    await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: '  H01AA 0123 4567 89  ' });

    await expect(trackingOf(shipment.id)).resolves.toEqual({
      trackingId: 'H01AA0123456789',
    });
  });

  it('corrects a mis-keyed number', async () => {
    const { shipment, admin } = await arrange({ trackingId: 'WRONG1' });

    await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'RIGHT2' });

    await expect(trackingOf(shipment.id)).resolves.toEqual({
      trackingId: 'RIGHT2',
    });
  });

  it('clears it when given an empty string', async () => {
    const { shipment, admin } = await arrange({ trackingId: 'TYPO99' });

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: '' });

    expect(res.status).toBe(200);
    await expect(trackingOf(shipment.id)).resolves.toEqual({ trackingId: null });
  });
});

describe('what is refused', () => {
  it('a cancelled shipment, which has no parcel to track', async () => {
    const { shipment, admin } = await arrange({ status: 'CANCELLED' });

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'ABC123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cancelled/i);
    await expect(trackingOf(shipment.id)).resolves.toEqual({ trackingId: null });
  });

  it('a number longer than the column holds', async () => {
    // VarChar(64). Without this check Postgres raises instead, as a 500.
    const { shipment, admin } = await arrange();

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'A'.repeat(65) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it('a number carrying characters no courier uses', async () => {
    const { shipment, admin } = await arrange();

    const res = await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: '../../etc/passwd' });

    expect(res.status).toBe(400);
    await expect(trackingOf(shipment.id)).resolves.toEqual({ trackingId: null });
  });

  it('a client user, who may not touch it at all', async () => {
    const { shipment, clientUser } = await arrange();

    const res = await as(clientUser)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'ABC123' });

    expect(res.status).toBe(403);
  });

  it('a shipment that does not exist', async () => {
    const { admin } = await arrange();

    const res = await as(admin)
      .put('/api/shipments/00000000-0000-0000-0000-000000000000/tracking')
      .send({ trackingId: 'ABC123' });

    expect(res.status).toBe(404);
  });
});

describe('the audit trail', () => {
  it('records who set it, and what it was before', async () => {
    const { shipment, admin } = await arrange({ trackingId: 'OLD111' });

    await as(admin)
      .put(`/api/shipments/${shipment.id}/tracking`)
      .send({ trackingId: 'NEW222' });

    const log = await prisma.auditLog.findFirst({
      where: { userId: admin.id, action: 'SHIPMENT_TRACKING_SET' },
    });

    expect(log).not.toBeNull();
    expect(log.details).toContain('OLD111');
    expect(log.details).toContain('NEW222');
  });
});
