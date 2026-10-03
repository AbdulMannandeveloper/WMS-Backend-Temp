/**
 * Linking a return to its shipment by hand.
 *
 * Most parcels come back on a label the warehouse never issued — the
 * customer's own, a marketplace return label — so the tracking number matches
 * no shipment. The operator who recognises the shipment can pick its line.
 * What must hold:
 *   - only dispatched lines carrying this product, for its own client, with
 *     something still out, are offered — and only those are accepted
 *   - a linked return counts against the line, so it blocks the shipment's
 *     delete like any other linked return
 *   - a label that already names a line wins over a different choice
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  makeWarehouseScenario,
  makeProduct,
  makeStockLevel,
  makeShipment,
  makeShipmentItem,
} from '../factories/index.js';

/** 5 of the scenario's product dispatched through the API, optionally under a label. */
const dispatch = async (s, { trackingId, quantity = 5 } = {}) => {
  const created = await as(s.admin)
    .post('/api/shipments')
    .send({
      ...(trackingId ? { trackingId } : {}),
      shipmentItems: [{ productId: s.product.id, sourceLocationId: s.location.id, quantity }],
    });
  expect(created.status).toBe(201);
  const item = await prisma.shipmentItem.findFirst({ where: { shipmentId: created.body.id } });
  return { shipment: created.body, item };
};

const lines = (actor, query) => as(actor).get('/api/returns/lines').query(query);

const record = (actor, body) => as(actor).post('/api/returns').send(body);

describe('the lines offered', () => {
  it('are dispatched lines of this product with something still out', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    const open = await dispatch(s);
    const done = await dispatch(s);
    await prisma.shipmentItem.update({ where: { id: done.item.id }, data: { returnedQuantity: 5 } });
    // Not dispatched yet: nothing on it can come back.
    const pending = await makeShipment(s.employee.id, s.client.id);
    await makeShipmentItem(pending.id, s.product.id, s.location.id, { quantity: 2 });

    const res = await lines(s.admin, { productId: s.product.id });

    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.shipmentItemId)).toEqual([open.item.id]);
    expect(res.body[0]).toMatchObject({ reference: open.shipment.reference, outstanding: 5 });
  });

  it('narrow to a shipment reference fragment', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    const first = await dispatch(s);
    await dispatch(s);

    const res = await lines(s.admin, { productId: s.product.id, q: first.shipment.reference.slice(-6) });

    expect(res.body.map((l) => l.reference)).toEqual([first.shipment.reference]);
  });

  it('are part of recording, so they need returns:create', async () => {
    const s = await makeWarehouseScenario({ permissions: ['returns:read'] });

    expect((await lines(s.employeeUser, { productId: s.product.id })).status).toBe(403);
  });
});

describe('recording with a chosen line', () => {
  it('links the return to it and counts against it', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    const { shipment, item } = await dispatch(s);

    const res = await record(s.admin, {
      trackingNumber: 'CUSTOMER-OWN-LABEL-1',
      productId: s.product.id,
      quantity: 2,
      shipmentItemId: item.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.shipmentId).toBe(shipment.id);
    expect(res.body.shipmentItemId).toBe(item.id);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(2);

    // Linked, so the shipment cannot be deleted out from under it.
    const del = await as(s.admin).delete(`/api/shipments/${shipment.id}`);
    expect(del.status).toBe(409);
    expect(del.body.dependents.blocking.map((r) => r.key)).toEqual(['returns']);
  });

  it('refuses a line that did not carry this product', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    const { item } = await dispatch(s);
    const other = await makeProduct(s.client.id);
    await makeStockLevel(other.id, s.location.id, { currentQuantity: 10 });

    const res = await record(s.admin, {
      trackingNumber: 'CUSTOMER-OWN-LABEL-2',
      productId: other.id,
      shipmentItemId: item.id,
    });

    expect(res.status).toBe(409);
    expect(await prisma.productReturn.count()).toBe(0);
  });

  it('refuses a line on a shipment that has not been dispatched', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    const pending = await makeShipment(s.employee.id, s.client.id);
    const item = await makeShipmentItem(pending.id, s.product.id, s.location.id, { quantity: 2 });

    const res = await record(s.admin, {
      trackingNumber: 'CUSTOMER-OWN-LABEL-3',
      productId: s.product.id,
      shipmentItemId: item.id,
    });

    expect(res.status).toBe(400);
    expect(await prisma.productReturn.count()).toBe(0);
  });

  it('refuses more than is still out on it', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    const { item } = await dispatch(s);

    const res = await record(s.admin, {
      trackingNumber: 'CUSTOMER-OWN-LABEL-4',
      productId: s.product.id,
      quantity: 6,
      shipmentItemId: item.id,
    });

    expect(res.status).toBe(409);
    expect((await prisma.shipmentItem.findUnique({ where: { id: item.id } })).returnedQuantity).toBe(0);
  });

  it('defers to a label that already names a different line', async () => {
    const s = await makeWarehouseScenario({ quantity: 100 });
    await dispatch(s, { trackingId: 'RM123456789GB' });
    const { item: other } = await dispatch(s);

    const res = await record(s.admin, {
      trackingNumber: 'RM123456789GB',
      productId: s.product.id,
      shipmentItemId: other.id,
    });

    expect(res.status).toBe(409);
    expect(await prisma.productReturn.count()).toBe(0);
  });
});
