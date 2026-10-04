/**
 * Landing and customs (Phase 3).
 *
 * Landing a dispatched flight moves its boxes to LANDED. A flight-wide hold puts
 * them in CUSTOMS_HOLD; clearing the flight lifts only flight-level holds and a
 * box held on its own stays held until released individually.
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
  return { flight, boxes };
};

const boxStatus = async (id) => (await as(admin).get(`/api/air-freight/boxes/${id}`)).body.status;

beforeEach(async () => { admin = await makeAdmin(); });

describe('landing', () => {
  it('moves dispatched boxes to LANDED', async () => {
    const { flight, boxes } = await setup(2);
    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/landed`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('LANDED');
    expect(await boxStatus(boxes[0].id)).toBe('LANDED');
  });

  it('refuses landing a flight that is not dispatched', async () => {
    const draft = await makeAirFreightFlight();
    expect((await as(admin).post(`/api/air-freight/flights/${draft.id}/landed`)).status).toBe(409);
  });
});

describe('customs', () => {
  it('holds the flight then clears it', async () => {
    const { flight, boxes } = await setup(2);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/landed`);

    const hold = await as(admin).post(`/api/air-freight/flights/${flight.id}/customs-hold`).send({ note: 'inspection' });
    expect(hold.body.status).toBe('CUSTOMS_HOLD');
    expect(await boxStatus(boxes[0].id)).toBe('CUSTOMS_HOLD');

    const cleared = await as(admin).post(`/api/air-freight/flights/${flight.id}/customs-cleared`);
    expect(cleared.body.status).toBe('CLEARED');
    expect(await boxStatus(boxes[0].id)).toBe('CLEARED');
  });

  it('needs the flight to have landed before a hold', async () => {
    const { flight } = await setup(1);
    expect((await as(admin).post(`/api/air-freight/flights/${flight.id}/customs-hold`).send({ note: 'x' })).status).toBe(400);
  });

  it('leaves a box-level hold held when the flight clears', async () => {
    const { flight, boxes } = await setup(2);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/landed`);
    // Hold one box on its own.
    await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/customs-hold`).send({ note: 'suspect' });
    expect(await boxStatus(boxes[0].id)).toBe('CUSTOMS_HOLD');

    // Clear the flight — the box-held one stays held, so the flight stays CUSTOMS_HOLD.
    await as(admin).post(`/api/air-freight/flights/${flight.id}/customs-cleared`);
    expect(await boxStatus(boxes[0].id)).toBe('CUSTOMS_HOLD');
    expect(await boxStatus(boxes[1].id)).toBe('CLEARED');

    // Release the box individually.
    const released = await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/customs-release`);
    expect(released.status).toBe(200);
    expect(['LANDED', 'CLEARED']).toContain(await boxStatus(boxes[0].id));
  });
});
