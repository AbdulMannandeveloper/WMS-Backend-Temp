/**
 * Receiving a freight shipment at the UK bench.
 *
 * This file is the module's reason for existing, so it is written as the
 * acceptance criteria rather than as unit coverage: scanning a code must name the
 * sender, an unknown code must not receive anything, and a parcel already checked
 * in must not be checked in twice. The last one is asserted on the table as well
 * as on the response — a friendly message that still wrote a second row would be
 * a parcel counted twice.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeFreightShipment,
  grantPermissions,
} from '../factories/index.js';

let admin;
let bench;
let shipment;

beforeEach(async () => {
  admin = await makeAdmin();
  const { user } = await makeEmployee({
    user: { firstName: 'John', lastName: 'Receiver' },
  });
  bench = user;
  await grantPermissions(bench, ['freight:read', 'freight:update']);

  shipment = await makeFreightShipment({
    status: 'DISPATCHED',
    dispatchedAt: new Date('2026-09-29T12:30:00.000Z'),
    senderName: 'Ali Khan',
    weight: '8.500',
  });
});

const lookup = (code, actor = bench) =>
  as(actor).get(`/api/freight-shipments/lookup/barcode/${code}`);

describe('scanning a barcode', () => {
  it('finds the shipment and names the sender — the whole point of the module', async () => {
    const res = await lookup(shipment.barcode);

    expect(res.status).toBe(200);
    expect(res.body.matchedOn).toBe('barcode');
    expect(res.body.shipment).toMatchObject({
      reference: shipment.reference,
      senderName: 'Ali Khan',
      receiverName: 'XYZ Trading',
      destinationCountry: 'United Kingdom',
      status: 'DISPATCHED',
    });
    expect(String(res.body.shipment.weight)).toBe('8.5');
    expect(res.body.shipment.description).toBe('Two boxes of textiles');
  });

  it('accepts the reference keyed in by hand when the label is unreadable', async () => {
    const res = await lookup(shipment.reference);

    expect(res.status).toBe(200);
    // Same value in both columns today, so this asserts the fallback path was
    // reachable at all rather than which column answered.
    expect(res.body.shipment.id).toBe(shipment.id);
  });

  it('answers 404 for a code belonging to no shipment, and changes nothing', async () => {
    const res = await lookup('NOT-A-REAL-CODE');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no shipment is associated with this barcode/i);

    const untouched = await prisma.freightShipment.findUnique({ where: { id: shipment.id } });
    expect(untouched.status).toBe('DISPATCHED');
    expect(await prisma.freightReceivingRecord.count()).toBe(0);
  });

  it('needs a session and the read grant', async () => {
    expect((await anon().get(`/api/freight-shipments/lookup/barcode/${shipment.barcode}`)).status).toBe(401);

    const { user: ungranted } = await makeEmployee();
    expect((await lookup(shipment.barcode, ungranted)).status).toBe(403);
  });
});

describe('confirming receipt', () => {
  const receive = (body = {}, actor = bench) =>
    as(actor).post(`/api/freight-shipments/${shipment.id}/receive`).send(body);

  it('marks the shipment RECEIVED and records who, when, the weight and the remarks', async () => {
    const res = await receive({
      barcode: shipment.barcode,
      actualWeight: '8.2',
      actualWeightUnit: 'KG',
      remarks: '300g light, box slightly crushed',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RECEIVED');
    expect(res.body.receiving).toMatchObject({
      barcode: shipment.barcode,
      remarks: '300g light, box slightly crushed',
      actualWeightUnit: 'KG',
      receivedByName: 'John Receiver',
    });
    expect(String(res.body.receiving.actualWeight)).toBe('8.2');
    expect(res.body.receiving.receivedAt).toBeTruthy();
  });

  it('receives without a scale reading', async () => {
    const res = await receive({});

    expect(res.status).toBe(200);
    expect(res.body.receiving.actualWeight).toBeNull();
    expect(res.body.receiving.actualWeightUnit).toBeNull();
    // Falls back to the shipment's own code for a receipt confirmed by hand.
    expect(res.body.receiving.barcode).toBe(shipment.barcode);
  });

  it('holds the full traceability chain afterwards: barcode → shipment → sender → receiver', async () => {
    await receive({ barcode: shipment.barcode });

    const res = await lookup(shipment.barcode);

    expect(res.body.shipment).toMatchObject({
      reference: shipment.reference,
      senderName: 'Ali Khan',
      status: 'RECEIVED',
    });
    expect(res.body.shipment.receiving.receivedByName).toBe('John Receiver');
  });

  it('refuses a second receipt and writes no second record', async () => {
    await receive({});

    const again = await receive({ remarks: 'scanned twice' });

    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already been received/i);
    // The bench screen names who and when, so the refusal carries the shipment.
    expect(again.body.shipment.receiving.receivedByName).toBe('John Receiver');

    expect(
      await prisma.freightReceivingRecord.count({
        where: { freightShipmentId: shipment.id },
      }),
    ).toBe(1);
  });

  it('refuses a shipment that was never dispatched', async () => {
    const booked = await makeFreightShipment({ status: 'BOOKED' });

    const res = await as(bench).post(`/api/freight-shipments/${booked.id}/receive`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/has not been dispatched yet/i);
    expect(await prisma.freightReceivingRecord.count()).toBe(0);
  });

  it('refuses a cancelled shipment', async () => {
    const cancelled = await makeFreightShipment({ status: 'CANCELLED' });

    const res = await as(bench)
      .post(`/api/freight-shipments/${cancelled.id}/receive`)
      .send({});

    expect(res.status).toBe(400);
    expect(await prisma.freightReceivingRecord.count()).toBe(0);
  });

  it('refuses an actual weight that is not a weight', async () => {
    const res = await receive({ actualWeight: '-2' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actual weight/i);
    expect(await prisma.freightReceivingRecord.count()).toBe(0);
  });

  it('answers 404 for a shipment id that does not exist', async () => {
    const res = await as(bench)
      .post('/api/freight-shipments/11111111-1111-1111-1111-111111111111/receive')
      .send({});
    expect(res.status).toBe(404);
  });

  it('logs the receipt against the sender, so the history answers who sent it', async () => {
    await receive({});

    const history = await as(admin).get(`/api/freight-shipments/${shipment.id}/history`);
    const received = history.body.find(
      (entry) => entry.action === 'FREIGHT_SHIPMENT_RECEIVED',
    );

    expect(received.userName).toBe('John Receiver');
    expect(JSON.parse(received.details)).toMatchObject({
      reference: shipment.reference,
      senderName: 'Ali Khan',
    });
  });
});
