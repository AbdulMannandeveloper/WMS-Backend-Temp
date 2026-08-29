/**
 * Billable services attached to a shipment.
 *
 * Priced from the client's agreed ClientService rate and frozen onto the
 * mapping, so dispatch bills what was agreed when the work was booked rather
 * than whatever the rate happens to be later.
 *
 * Editable only while the shipment is PENDING — once it is ready or gone, the
 * charges are settled.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeService,
  makeClientService,
} from '../factories/index.js';

const arrange = async (shipmentOverrides = {}) => {
  const scenario = await makeWarehouseScenario();
  const shipment = await makeShipment(
    scenario.employee.id,
    scenario.client.id,
    shipmentOverrides
  );
  const service = await makeService({ description: 'Pallet wrapping' });
  await makeClientService(scenario.client.id, service.id, { chargedPrice: '7.25' });
  return { ...scenario, shipment, service };
};

describe('shipment services', () => {
  it('an admin attaches a service at the agreed rate', async () => {
    const { admin, shipment, service } = await arrange();

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 3 });

    expect(res.status).toBe(201);
    expect(Number(res.body.appliedUnitPrice)).toBe(7.25);
    expect(Number(res.body.quantity)).toBe(3);
  });

  it('staff can see what a shipment will be charged for', async () => {
    const { admin, employeeUser, shipment, service } = await arrange();
    await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });

    const res = await as(employeeUser).get(`/api/shipments/${shipment.id}/services`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('an employee cannot attach or remove one', async () => {
    const { admin, employeeUser, shipment, service } = await arrange();

    const added = await as(employeeUser)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });
    expect(added.status).toBe(403);

    const created = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });
    const removed = await as(employeeUser).delete(
      `/api/shipments/${shipment.id}/services/${created.body.id}`
    );
    expect(removed.status).toBe(403);
  });

  it('an admin removes a service', async () => {
    const { admin, shipment, service } = await arrange();
    const created = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });

    const res = await as(admin).delete(
      `/api/shipments/${shipment.id}/services/${created.body.id}`
    );

    expect(res.status).toBe(200);
    await expect(prisma.shipmentServiceMapping.count()).resolves.toBe(0);
  });

  it('refuses a service the client has no agreed rate for', async () => {
    const { admin, shipment } = await arrange();
    const unpriced = await makeService({ description: 'Unpriced' });

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: unpriced.id, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not set up for this client/i);
  });

  it('refuses a non-positive quantity', async () => {
    const { admin, shipment, service } = await arrange();

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 0 });

    expect(res.status).toBe(400);
  });

  it('applies a service to a shipment only once', async () => {
    const { admin, shipment, service } = await arrange();
    await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });

    const second = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });

    // Quantity carries repetition; the unique constraint carries identity.
    expect(second.status).toBe(400);
    await expect(prisma.shipmentServiceMapping.count()).resolves.toBe(1);
  });

  it('cannot be changed once the shipment has left PENDING', async () => {
    const { admin, shipment, service } = await arrange({
      status: 'READY_FOR_DISPATCH',
    });

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/READY_FOR_DISPATCH/);
  });

  it('records attach and remove in the audit trail', async () => {
    const { admin, shipment, service } = await arrange();
    const created = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });
    await as(admin).delete(
      `/api/shipments/${shipment.id}/services/${created.body.id}`
    );

    const logs = await prisma.auditLog.findMany({ orderBy: { timestamp: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual([
      'SHIPMENT_SERVICE_ADDED',
      'SHIPMENT_SERVICE_REMOVED',
    ]);
  });
});
