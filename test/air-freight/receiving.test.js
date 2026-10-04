/**
 * The receiving bench (§1C) and close-receipt.
 *
 * A scan is a 200 with an `outcome`, never a thrown refusal. The first receive
 * auto-lands the flight; an unknown code becomes an OVER exception; closing the
 * receipt turns everything unscanned into SHORT with an exception each, and a
 * later scan of a short box resolves it.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeCourier, makeAirFreightFlight, makeAirFreightBox } from '../factories/index.js';

let admin;

const setup = async (boxCount = 2) => {
  const client = (await makeClient()).client;
  const courier = await makeCourier();
  const flight = await makeAirFreightFlight(client.id, { mawbNumber: '176-12345675' });
  const boxes = [];
  for (let i = 0; i < boxCount; i += 1) boxes.push(await makeAirFreightBox(flight.id, courier.id));
  await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
  return { client, courier, flight, boxes };
};

const scan = (flightId, code) => as(admin).post(`/api/air-freight/flights/${flightId}/receive-scan`).send({ code });

beforeEach(async () => { admin = await makeAdmin(); });

describe('receive scan', () => {
  it('receives a dispatched box (green) and auto-lands the flight', async () => {
    const { flight, boxes } = await setup(2);
    const res = await scan(flight.id, boxes[0].trackingNumber);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('RECEIVED');
    expect(res.body.counters.received).toBe(1);
    expect(res.body.counters.expected).toBe(2);

    const f = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(f.body.landedAt).toBeTruthy();
    expect(f.body.status).toBe('RECEIVING');
  });

  it('is idempotent — a second scan says ALREADY_RECEIVED, not a second receive', async () => {
    const { flight, boxes } = await setup(1);
    await scan(flight.id, boxes[0].trackingNumber);
    const again = await scan(flight.id, boxes[0].trackingNumber);
    expect(again.body.outcome).toBe('ALREADY_RECEIVED');
    expect(again.body.counters.received).toBe(1);
  });

  it('flags a box from another flight', async () => {
    const { flight } = await setup(1);
    const other = await setup(1);
    const res = await scan(flight.id, other.boxes[0].trackingNumber);
    expect(res.body.outcome).toBe('OTHER_FLIGHT');
  });

  it('raises a single OVER exception for an unknown code, even scanned twice', async () => {
    const { flight } = await setup(1);
    const a = await scan(flight.id, 'UNKNOWN999');
    const b = await scan(flight.id, 'UNKNOWN999');
    expect(a.body.outcome).toBe('OVER');
    expect(b.body.outcome).toBe('OVER');
    expect(b.body.counters.over).toBe(1);
  });

  it('refuses a box held by customs', async () => {
    const { flight, boxes } = await setup(1);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/landed`);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/customs-hold`).send({ note: 'x-ray' });
    const res = await scan(flight.id, boxes[0].trackingNumber);
    expect(res.body.outcome).toBe('CUSTOMS_HOLD');
  });

  it('400s a malformed code and a draft flight', async () => {
    const { flight, boxes } = await setup(1);
    expect((await scan(flight.id, '!!!')).status).toBe(400);
    const draft = await makeAirFreightFlight();
    expect((await scan(draft.id, boxes[0].trackingNumber)).status).toBe(400);
  });
});

describe('close receipt', () => {
  it('turns unscanned boxes into SHORT with an exception, and a later scan resolves it', async () => {
    const { flight, boxes } = await setup(2);
    await scan(flight.id, boxes[0].trackingNumber); // receive one

    const closed = await as(admin).post(`/api/air-freight/flights/${flight.id}/close-receipt`);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('RECEIVED_PARTIAL');

    const short = await as(admin).get(`/api/air-freight/boxes/${boxes[1].id}`);
    expect(short.body.status).toBe('SHORT');

    // Found after close: scan resolves the SHORT.
    const found = await scan(flight.id, boxes[1].trackingNumber);
    expect(found.body.outcome).toBe('RECEIVED');
    const now = await as(admin).get(`/api/air-freight/boxes/${boxes[1].id}`);
    expect(now.body.status).toBe('RECEIVED');
  });
});
