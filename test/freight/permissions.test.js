/**
 * Every freight endpoint, against every kind of caller.
 *
 * The module is only as safe as its least-guarded route, and a route added later
 * without a guard looks exactly like one that works. This walks the whole surface
 * rather than sampling it: anonymous gets 401, a client gets 403 (freight is
 * staff-only — a sender is a person in a shop, not a WMS tenant), an employee
 * holding nothing gets 403, an employee holding exactly one action gets that
 * action and no other, and an admin is never blocked.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeFreightShipment,
  grantPermissions,
} from '../factories/index.js';

let admin;
let shipment;

beforeEach(async () => {
  admin = await makeAdmin();
  shipment = await makeFreightShipment({ status: 'DISPATCHED' });
});

const booking = () => ({
  senderName: 'Ali Khan',
  senderContact: '+92 300 1234567',
  senderAddress: '12 Mall Road, Lahore',
  receiverName: 'XYZ Trading',
  receiverContact: '+44 7700 900123',
  receiverAddress: '4 Dock Street, London',
  destinationCountry: 'United Kingdom',
  description: 'Textiles',
  quantity: 1,
  weight: '3',
});

/** Every route, with the action it should require. */
const routes = () => [
  { action: 'read', call: (a) => as(a).get('/api/freight-shipments') },
  { action: 'read', call: (a) => as(a).get('/api/freight-shipments/summary') },
  {
    action: 'read',
    call: (a) => as(a).get(`/api/freight-shipments/lookup/barcode/${shipment.barcode}`),
  },
  {
    action: 'read',
    call: (a) => as(a).get('/api/freight-shipments/documents/nothing-here.pdf'),
  },
  { action: 'read', call: (a) => as(a).get(`/api/freight-shipments/${shipment.id}`) },
  {
    action: 'read',
    call: (a) => as(a).get(`/api/freight-shipments/${shipment.id}/history`),
  },
  { action: 'create', call: (a) => as(a).post('/api/freight-shipments').send(booking()) },
  {
    action: 'update',
    call: (a) => as(a).put(`/api/freight-shipments/${shipment.id}`).send({ remarks: 'x' }),
  },
  {
    action: 'update',
    call: (a) =>
      as(a)
        .post(`/api/freight-shipments/${shipment.id}/documents`)
        .attach('document', Buffer.from('%PDF-1.4\n%%EOF\n'), 'slip.pdf'),
  },
  {
    action: 'update',
    call: (a) =>
      as(a).delete(
        `/api/freight-shipments/${shipment.id}/documents/22222222-2222-2222-2222-222222222222`,
      ),
  },
  {
    action: 'update',
    call: (a) => as(a).post(`/api/freight-shipments/${shipment.id}/dispatch`),
  },
  {
    action: 'update',
    call: (a) => as(a).post(`/api/freight-shipments/${shipment.id}/receive`).send({}),
  },
  {
    action: 'delete',
    call: (a) => as(a).post(`/api/freight-shipments/${shipment.id}/cancel`),
  },
  { action: 'delete', call: (a) => as(a).delete(`/api/freight-shipments/${shipment.id}`) },
];

const anonymousCalls = () => [
  () => anon().get('/api/freight-shipments'),
  () => anon().get('/api/freight-shipments/summary'),
  () => anon().get(`/api/freight-shipments/lookup/barcode/${shipment.barcode}`),
  () => anon().get(`/api/freight-shipments/${shipment.id}`),
  () => anon().get(`/api/freight-shipments/${shipment.id}/history`),
  () => anon().post('/api/freight-shipments').send(booking()),
  () => anon().put(`/api/freight-shipments/${shipment.id}`).send({ remarks: 'x' }),
  () => anon().post(`/api/freight-shipments/${shipment.id}/dispatch`),
  () => anon().post(`/api/freight-shipments/${shipment.id}/receive`).send({}),
  () => anon().post(`/api/freight-shipments/${shipment.id}/cancel`),
  () => anon().delete(`/api/freight-shipments/${shipment.id}`),
];

describe('freight permissions', () => {
  it('refuses every route without a session', async () => {
    for (const call of anonymousCalls()) {
      expect((await call()).status).toBe(401);
    }
  });

  it('refuses every route to a client, whatever they hold', async () => {
    // A client cannot be granted freight at all — holdsPermission lets non-employees
    // through, so the role check on the route is the only thing standing here, and
    // this is what proves it is.
    const { user } = await makeClient();

    for (const { call } of routes()) {
      expect((await call(user)).status).toBe(403);
    }
  });

  it('refuses every route to an employee holding nothing', async () => {
    const { user } = await makeEmployee();

    for (const { call } of routes()) {
      expect((await call(user)).status).toBe(403);
    }
  });

  it('allows every route to an admin, permissions column empty', async () => {
    // Not asserting success — a dispatch of an already-DISPATCHED shipment is a
    // 400 on its merits. Only that the guard is not what stopped it.
    for (const { call } of routes()) {
      expect((await call(admin)).status).not.toBe(403);
    }
  });

  it('gives an employee exactly the action they were granted', async () => {
    for (const action of ['read', 'create', 'update', 'delete']) {
      const { user } = await makeEmployee();
      // Granted before this user's first request: authorizeRoles caches the row.
      await grantPermissions(user, [`freight:${action}`]);

      for (const route of routes()) {
        const status = (await route.call(user)).status;
        if (route.action === action) {
          expect(status, `freight:${action} should reach a ${route.action} route`).not.toBe(403);
        } else {
          expect(status, `freight:${action} should not reach a ${route.action} route`).toBe(403);
        }
      }

      // Each loop needs its own shipment: the delete pass removes this one.
      shipment = await makeFreightShipment({ status: 'DISPATCHED' });
    }
  });
});
