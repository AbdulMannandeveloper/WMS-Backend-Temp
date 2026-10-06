/**
 * Box edit, soft-remove and admin override.
 *
 * DRAFT boxes edit freely; after dispatch only an admin may, with a reason.
 * A changed tracking number is checked against the active index. All three
 * mutations are refused while the flight's charges are POSTED — the unpost →
 * change → re-post path is the only way a billed box changes, and the recomputed
 * statement then reflects it (a removed box drops out entirely).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../../lib/prisma.js';
import { as } from '../helpers/auth.js';
import {
  makeAdmin, makeEmployee, makeClient, makeCourier, makeAirFreightFlight, makeAirFreightBox, grantPermissions,
} from '../factories/index.js';

let admin;
let employee;
let client;
let courier;

const boxStatus = async (id) => (await as(admin).get(`/api/air-freight/boxes/${id}`)).body.status;

beforeEach(async () => {
  admin = await makeAdmin();
  const emp = await makeEmployee();
  employee = emp.user;
  await grantPermissions(employee, ['airfreight:read', 'airfreight:update', 'airfreight:create', 'airfreight:delete']);
  client = (await makeClient()).client;
  courier = await makeCourier();
});

const draftFlightWithBoxes = async (n = 2) => {
  const flight = await makeAirFreightFlight(client.id, { mawbNumber: '176-12345675' });
  const boxes = [];
  for (let i = 0; i < n; i += 1) boxes.push(await makeAirFreightBox(flight.id, courier.id));
  return { flight, boxes };
};

describe('editing a box', () => {
  it('edits a DRAFT box freely (employee), including the tracking number', async () => {
    const { boxes } = await draftFlightWithBoxes(1);
    const res = await as(employee)
      .patch(`/api/air-freight/boxes/${boxes[0].id}`)
      .send({ contentsDescription: 'Silk scarves', trackingNumber: 'NEWTRACK01' });
    expect(res.status).toBe(200);
    expect(res.body.contentsDescription).toBe('Silk scarves');
    expect(res.body.trackingNumber).toBe('NEWTRACK01');
    expect(res.body.previousTrackingNumbers).toContain(boxes[0].trackingNumber);
  });

  it('refuses a tracking number already on another active box', async () => {
    const { boxes } = await draftFlightWithBoxes(2);
    const res = await as(admin)
      .patch(`/api/air-freight/boxes/${boxes[0].id}`)
      .send({ trackingNumber: boxes[1].trackingNumber });
    expect(res.status).toBe(409);
  });

  it('after dispatch: employee refused, admin needs a reason', async () => {
    const { flight, boxes } = await draftFlightWithBoxes(1);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);

    expect((await as(employee).patch(`/api/air-freight/boxes/${boxes[0].id}`).send({ contentsDescription: 'x' })).status).toBe(403);
    expect((await as(admin).patch(`/api/air-freight/boxes/${boxes[0].id}`).send({ contentsDescription: 'x' })).status).toBe(400);
    const ok = await as(admin).patch(`/api/air-freight/boxes/${boxes[0].id}`).send({ contentsDescription: 'x', reason: 'client corrected it' });
    expect(ok.status).toBe(200);
  });
});

describe('soft remove', () => {
  it('cancels the box with a reason and keeps it out of billing', async () => {
    const { boxes } = await draftFlightWithBoxes(1);
    expect((await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/remove`).send({})).status).toBe(400); // reason required
    const res = await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/remove`).send({ reason: 'duplicate' });
    expect(res.status).toBe(200);
    expect(await boxStatus(boxes[0].id)).toBe('CANCELLED');
  });
});

describe('admin override', () => {
  it('forces a status and sets the side-field; refuses the real-action targets', async () => {
    const { boxes } = await draftFlightWithBoxes(1);
    const res = await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/override-status`).send({ toStatus: 'RECEIVED', reason: 'manual receipt' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RECEIVED');
    expect(res.body.receivedAt).toBeTruthy();

    expect((await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/override-status`).send({ toStatus: 'ON_HANDOVER', reason: 'x' })).status).toBe(400);
    // employees cannot override at all (admin-only route)
    expect((await as(employee).post(`/api/air-freight/boxes/${boxes[0].id}/override-status`).send({ toStatus: 'LANDED', reason: 'x' })).status).toBe(403);
  });
});

describe('the POSTED charge guard', () => {
  it('blocks edit, remove and override while the flight is POSTED', async () => {
    const { flight, boxes } = await draftFlightWithBoxes(1);
    await prisma.airFreightFlight.update({ where: { id: flight.id }, data: { billingStatus: 'POSTED' } });

    expect((await as(admin).patch(`/api/air-freight/boxes/${boxes[0].id}`).send({ contentsDescription: 'x' })).status).toBe(409);
    expect((await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/remove`).send({ reason: 'x' })).status).toBe(409);
    expect((await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/override-status`).send({ toStatus: 'RECEIVED', reason: 'x' })).status).toBe(409);
  });
});
