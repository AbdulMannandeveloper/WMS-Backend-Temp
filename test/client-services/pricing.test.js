/**
 * Agreed rates, and the trap that hid inside them.
 *
 * getClientServiceByClientIdAndServiceId was a findMany despite naming a pair
 * the schema declares unique. It handed back an array, and an empty array is
 * truthy — so `if (!clientService) throw` never fired for a client who had no
 * agreed rate, and appliedUnitPrice was read off the array as undefined. The
 * shipment was billed at nothing and nobody was told.
 *
 * It is findFirst now. These tests hold that shut.
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

const arrange = async () => {
  const scenario = await makeWarehouseScenario();
  const shipment = await makeShipment(scenario.employee.id, scenario.client.id);
  const service = await makeService({ description: 'Pallet wrapping', unit: 'pallet' });
  return { ...scenario, shipment, service };
};

describe('a service with no agreed rate', () => {
  it('is refused rather than billed at nothing', async () => {
    // The bug: this used to succeed silently and produce a zero-value line.
    const { shipment, service, admin } = await arrange();

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not set up for this client/i);
  });

  it('leaves no mapping behind when it refuses', async () => {
    const { shipment, service, admin } = await arrange();

    await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 2 });

    const mappings = await prisma.shipmentServiceMapping.findMany({
      where: { shipmentId: shipment.id },
    });
    expect(mappings).toHaveLength(0);
  });

  it('never records an undefined or zero unit price', async () => {
    // The shape the bug actually took, asserted directly.
    const { shipment, service, admin } = await arrange();

    await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 2 });

    const all = await prisma.shipmentServiceMapping.findMany();
    for (const m of all) {
      expect(m.appliedUnitPrice).not.toBeNull();
      expect(Number(m.appliedUnitPrice)).toBeGreaterThan(0);
    }
  });
});

describe('a service with an agreed rate', () => {
  it('is applied at the agreed price', async () => {
    const { shipment, service, client, admin } = await arrange();
    await makeClientService(client.id, service.id, { chargedPrice: '12.50' });

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 3 });

    expect(res.status).toBe(201);
    const mapping = await prisma.shipmentServiceMapping.findFirst({
      where: { shipmentId: shipment.id },
    });
    expect(Number(mapping.appliedUnitPrice)).toBe(12.5);
  });

  it('does not leak another client rate into this one', async () => {
    // The unique key is (clientId, serviceId); a findFirst on serviceId alone
    // would happily pick up somebody else's price.
    const { shipment, service, admin } = await arrange();
    const other = await makeWarehouseScenario();
    await makeClientService(other.client.id, service.id, { chargedPrice: '99.00' });

    const res = await as(admin)
      .post(`/api/shipments/${shipment.id}/services`)
      .send({ serviceId: service.id, quantity: 1 });

    expect(res.status).toBe(400);
  });
});

describe('the finder itself', () => {
  it('returns a single row, not an array', async () => {
    // The regression in one line: an array here is what made every downstream
    // guard dead code.
    const repo = await import('../../repositories/client_service.repository.js');
    const { client, service } = await arrange();
    await makeClientService(client.id, service.id, { chargedPrice: '5.00' });

    const found = await repo.default.getClientServiceByClientIdAndServiceId(
      client.id,
      service.id
    );

    expect(Array.isArray(found)).toBe(false);
    expect(found).not.toBeNull();
    expect(Number(found.chargedPrice)).toBe(5);
  });

  it('returns null — not [] — when there is no agreed rate', async () => {
    const repo = await import('../../repositories/client_service.repository.js');
    const { client, service } = await arrange();

    const found = await repo.default.getClientServiceByClientIdAndServiceId(
      client.id,
      service.id
    );

    // `[]` would be truthy and would pass any `if (!found)` check.
    expect(found).toBeNull();
    expect(Boolean(found)).toBe(false);
  });
});
