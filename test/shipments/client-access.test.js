/**
 * A client seeing their own shipments.
 *
 * The portal could show stock, services and invoices but not the shipments those
 * invoices charge for — so the one question a client actually rings about,
 * "where is my order?", was the one it could not answer.
 *
 * Scoped through canAccessClientId, and a foreign client id comes back 404
 * rather than 403: a 403 confirms the id exists, which is a probe.
 */

import { describe, it, expect } from 'vitest';

import { as, anon } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeShipment,
  makeShipmentItem,
} from '../factories/index.js';

describe('a client', () => {
  it('reads their own shipments', async () => {
    const ctx = await makeWarehouseScenario();
    await makeShipment(ctx.employee.id, ctx.client.id);

    const res = await as(ctx.clientUser).get(`/api/shipments/client/${ctx.client.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('sees every status, including cancelled', async () => {
    // Someone asking where an order is usually means one that has not gone yet.
    const ctx = await makeWarehouseScenario();
    for (const status of ['PENDING', 'READY_FOR_DISPATCH', 'CANCELLED']) {
      await makeShipment(ctx.employee.id, ctx.client.id, { status });
    }

    const res = await as(ctx.clientUser).get(`/api/shipments/client/${ctx.client.id}`);

    expect(res.body).toHaveLength(3);
  });

  it('gets 404, not 403, for another client', async () => {
    const ctx = await makeWarehouseScenario();
    const other = await makeWarehouseScenario();
    await makeShipment(other.employee.id, other.client.id);

    const res = await as(ctx.clientUser).get(`/api/shipments/client/${other.client.id}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(other.client.id);
  });

  it('cannot reach the all-shipments list', async () => {
    const ctx = await makeWarehouseScenario();
    expect((await as(ctx.clientUser).get('/api/shipments/')).status).toBe(403);
  });

  it('sees what is in the shipment, but never which bin it came out of', async () => {
    // The portal lets a client open a shipment and read its lines, so the items
    // have to travel. Where we picked them from is our warehouse layout — it
    // used to be sent and simply go unrendered, which is one devtools tab away
    // from being sent to the client.
    const ctx = await makeWarehouseScenario();
    const shipment = await makeShipment(ctx.employee.id, ctx.client.id);
    await makeShipmentItem(shipment.id, ctx.product.id, ctx.location.id, {
      quantity: 4,
    });

    const res = await as(ctx.clientUser).get(`/api/shipments/client/${ctx.client.id}`);

    const [item] = res.body[0].shipmentItems;
    expect(item.quantity).toBe(4);
    expect(item.product.productName).toBe(ctx.product.productName);

    expect(item.sourceLocationId).toBeUndefined();
    expect(item.sourceLocation).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(ctx.location.id);
  });

  it('cannot create or dispatch one', async () => {
    const ctx = await makeWarehouseScenario();
    const shipment = await makeShipment(ctx.employee.id, ctx.client.id, {
      status: 'READY_FOR_DISPATCH',
    });

    expect((await as(ctx.clientUser).post('/api/shipments/').send({})).status).toBe(403);
    expect(
      (await as(ctx.clientUser).post(`/api/shipments/${shipment.id}/dispatch`)).status
    ).toBe(403);
  });
});

describe('staff', () => {
  it('still read any client', async () => {
    const ctx = await makeWarehouseScenario();
    const other = await makeWarehouseScenario();
    await makeShipment(other.employee.id, other.client.id);

    const res = await as(ctx.employeeUser).get(`/api/shipments/client/${other.client.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('still get the bin, because they are the ones walking to it', async () => {
    const ctx = await makeWarehouseScenario();
    const shipment = await makeShipment(ctx.employee.id, ctx.client.id);
    await makeShipmentItem(shipment.id, ctx.product.id, ctx.location.id);

    const res = await as(ctx.employeeUser).get(`/api/shipments/client/${ctx.client.id}`);

    expect(res.body[0].shipmentItems[0].sourceLocationId).toBe(ctx.location.id);
  });
});

describe('anonymous requests', () => {
  it('are refused', async () => {
    const ctx = await makeWarehouseScenario();
    expect((await anon().get(`/api/shipments/client/${ctx.client.id}`)).status).toBe(401);
  });
});
