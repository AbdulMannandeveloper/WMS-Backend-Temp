/**
 * Exceptions: the resolution map by role, write-off eligibility, OVER becoming a
 * received box, relabelling, and the client's decision round-trip.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../../lib/prisma.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeEmployee, makeClient, makeCourier, makeAirFreightFlight, makeAirFreightBox, grantPermissions } from '../factories/index.js';

let admin;
let employee;
let clientUser;
let client;
let courier;
let flight;

const makeException = (data) => prisma.airFreightException.create({
  data: { flightId: flight.id, ownerRole: 'ADMIN', status: 'OPEN', ...data },
});

beforeEach(async () => {
  admin = await makeAdmin();
  const emp = await makeEmployee();
  employee = emp.user;
  await grantPermissions(employee, ['airfreight:read', 'airfreight:update', 'airfreight:create', 'airfreight:delete']);
  const c = await makeClient();
  clientUser = c.user;
  client = c.client;
  courier = await makeCourier();
  flight = await makeAirFreightFlight(client.id, { mawbNumber: '176-12345675', status: 'RECEIVING', landedAt: new Date() });
});

describe('resolution map by role', () => {
  it('lets an admin write off a short but refuses a non-admin', async () => {
    const box = await makeAirFreightBox(flight.id, courier.id, { status: 'SHORT' });
    const exc = await makeException({ boxId: box.id, type: 'SHORT' });

    const byEmp = await as(employee).post(`/api/air-freight/exceptions/${exc.id}/resolve`).send({ resolution: 'WRITTEN_OFF' });
    expect(byEmp.status).toBe(403);

    const byAdmin = await as(admin).post(`/api/air-freight/exceptions/${exc.id}/resolve`).send({ resolution: 'WRITTEN_OFF' });
    expect(byAdmin.status).toBe(200);
    expect((await as(admin).get(`/api/air-freight/boxes/${box.id}`)).body.status).toBe('WRITTEN_OFF');
  });

  it('rejects a resolution that does not fit the type', async () => {
    const box = await makeAirFreightBox(flight.id, courier.id, { status: 'SHORT' });
    const exc = await makeException({ boxId: box.id, type: 'SHORT' });
    expect((await as(admin).post(`/api/air-freight/exceptions/${exc.id}/resolve`).send({ resolution: 'RELABELLED' })).status).toBe(400);
  });
});

describe('write-off eligibility', () => {
  it('counts a short open at least 7 days', async () => {
    const box = await makeAirFreightBox(flight.id, courier.id, { status: 'SHORT' });
    await makeException({ boxId: box.id, type: 'SHORT', raisedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    const res = await as(admin).get('/api/air-freight/exceptions/summary');
    expect(res.status).toBe(200);
    expect(res.body.eligibleForWriteOff).toBeGreaterThanOrEqual(1);
  });
});

describe('OVER → added to manifest', () => {
  it('creates a received box from an over exception', async () => {
    const exc = await makeException({ type: 'OVER', scannedCode: 'OVER12345' });
    const res = await as(admin).post(`/api/air-freight/exceptions/${exc.id}/resolve`).send({
      resolution: 'ADDED_TO_MANIFEST',
      boxData: { trackingNumber: 'OVER12345', courierId: courier.id, weightKg: 2, lengthCm: 10, widthCm: 10, heightCm: 10, declaredValue: 5, currency: 'GBP', consigneeName: 'N', consigneePostcode: 'P' },
    });
    expect(res.status).toBe(200);
    const box = await prisma.airFreightBox.findFirst({ where: { flightId: flight.id, trackingNumber: 'OVER12345' } });
    expect(box.status).toBe('RECEIVED');
    expect(box.receivedAt).toBeTruthy();
  });
});

describe('relabelling', () => {
  it('changes the tracking number and keeps the previous one', async () => {
    const box = await makeAirFreightBox(flight.id, courier.id, { status: 'ON_HOLD', trackingNumber: 'OLDLABEL1' });
    const exc = await makeException({ boxId: box.id, type: 'LABEL_UNREADABLE', status: 'AWAITING_CLIENT', ownerRole: 'CLIENT' });
    const res = await as(admin).post(`/api/air-freight/exceptions/${exc.id}/resolve`).send({ resolution: 'RELABELLED', newTrackingNumber: 'NEWLABEL1' });
    expect(res.status).toBe(200);
    const fresh = await prisma.airFreightBox.findUnique({ where: { id: box.id } });
    expect(fresh.trackingNumber).toBe('NEWLABEL1');
    expect(fresh.previousTrackingNumbers).toContain('OLDLABEL1');
    expect(fresh.status).toBe('RECEIVED');
  });
});

describe('client decision', () => {
  it('records the client decision and reopens for staff', async () => {
    const box = await makeAirFreightBox(flight.id, courier.id, { status: 'ON_HOLD' });
    const exc = await makeException({ boxId: box.id, type: 'DAMAGED', status: 'AWAITING_CLIENT', ownerRole: 'CLIENT' });

    const res = await as(clientUser).post(`/api/air-freight/exceptions/${exc.id}/client-decision`).field('decision', 'SHIP_AS_IS');
    expect(res.status).toBe(200);

    const fresh = await prisma.airFreightException.findUnique({ where: { id: exc.id } });
    expect(fresh.clientDecision).toBe('SHIP_AS_IS');
    expect(fresh.status).toBe('OPEN');

    // An employee cannot post a client decision.
    expect((await as(employee).post(`/api/air-freight/exceptions/${exc.id}/client-decision`).field('decision', 'HOLD')).status).toBe(403);
  });
});
