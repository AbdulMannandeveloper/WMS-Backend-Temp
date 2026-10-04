/**
 * The handover bench (§1D).
 *
 * Received boxes of one courier are scanned onto a handover, which closes with a
 * proof photo and marks them HANDED_TO_COURIER. A scan after close is refused
 * (409, no box stranded); the wrong courier is refused; closing without a photo
 * is refused. When every box is handed over and the receipt is closed, the
 * flight reaches COMPLETED.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeCourier, makeAirFreightFlight, makeAirFreightBox } from '../factories/index.js';

let admin;

const PHOTO = Buffer.from('fake-jpeg');

const scan = (flightId, code) => as(admin).post(`/api/air-freight/flights/${flightId}/receive-scan`).send({ code });
const boxStatus = async (id) => (await as(admin).get(`/api/air-freight/boxes/${id}`)).body.status;

/** A flight whose boxes are all received, on one courier. */
const receivedFlight = async (boxCount = 2) => {
  const client = (await makeClient()).client;
  const courier = await makeCourier();
  const flight = await makeAirFreightFlight(client.id, { mawbNumber: '176-12345675' });
  const boxes = [];
  for (let i = 0; i < boxCount; i += 1) boxes.push(await makeAirFreightBox(flight.id, courier.id));
  await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
  for (const b of boxes) await scan(flight.id, b.trackingNumber);
  return { client, courier, flight, boxes };
};

beforeEach(async () => { admin = await makeAdmin(); });

describe('handover flow', () => {
  it('opens, scans received boxes on, and closes to HANDED_TO_COURIER; flight COMPLETED', async () => {
    const { courier, flight, boxes } = await receivedFlight(2);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/close-receipt`);

    const open = await as(admin).post('/api/air-freight/handovers').send({ courierId: courier.id, depotName: 'UPS Hub' });
    expect(open.status).toBe(201);
    expect(open.body.reference).toMatch(/^HO-\d{4}-\d{6}$/);
    const hoId = open.body.id;

    for (const b of boxes) {
      const s = await as(admin).post(`/api/air-freight/handovers/${hoId}/scan`).send({ code: b.trackingNumber });
      expect(s.body.outcome).toBe('ADDED');
    }

    const noPhoto = await as(admin).post(`/api/air-freight/handovers/${hoId}/close`).field('confirmedCount', '2');
    expect(noPhoto.status).toBe(400);

    const closed = await as(admin)
      .post(`/api/air-freight/handovers/${hoId}/close`)
      .field('confirmedCount', '2')
      .field('depotStaffName', 'D Singh')
      .attach('photo', PHOTO, { filename: 'proof.jpg', contentType: 'image/jpeg' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');

    expect(await boxStatus(boxes[0].id)).toBe('HANDED_TO_COURIER');
    const f = await as(admin).get(`/api/air-freight/flights/${flight.id}`);
    expect(f.body.status).toBe('COMPLETED');

    // A scan after close is refused, nothing stranded.
    const late = await as(admin).post(`/api/air-freight/handovers/${hoId}/scan`).send({ code: boxes[0].trackingNumber });
    expect(late.status).toBe(409);
  });

  it('refuses a box of the wrong courier', async () => {
    const { courier, flight } = await receivedFlight(1);
    const dpd = await makeCourier();
    const dpdBox = await makeAirFreightBox(flight.id, dpd.id);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`).catch(() => null); // already dispatched; no-op 409
    await scan(flight.id, dpdBox.trackingNumber);

    const open = await as(admin).post('/api/air-freight/handovers').send({ courierId: courier.id, depotName: 'UPS Hub' });
    const res = await as(admin).post(`/api/air-freight/handovers/${open.body.id}/scan`).send({ code: dpdBox.trackingNumber });
    expect(res.body.outcome).toBe('WRONG_COURIER');
  });

  it('cancels an open handover and returns its boxes to RECEIVED', async () => {
    const { courier, flight, boxes } = await receivedFlight(1);
    const open = await as(admin).post('/api/air-freight/handovers').send({ courierId: courier.id, depotName: 'UPS Hub' });
    await as(admin).post(`/api/air-freight/handovers/${open.body.id}/scan`).send({ code: boxes[0].trackingNumber });
    expect(await boxStatus(boxes[0].id)).toBe('ON_HANDOVER');

    const cancelled = await as(admin).post(`/api/air-freight/handovers/${open.body.id}/cancel`);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await boxStatus(boxes[0].id)).toBe('RECEIVED');

    void flight;
  });

  it('serves a manifest PDF', async () => {
    const { courier, boxes, flight } = await receivedFlight(1);
    const open = await as(admin).post('/api/air-freight/handovers').send({ courierId: courier.id, depotName: 'UPS Hub' });
    await as(admin).post(`/api/air-freight/handovers/${open.body.id}/scan`).send({ code: boxes[0].trackingNumber });
    const pdf = await as(admin).get(`/api/air-freight/handovers/${open.body.id}/manifest.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    void flight;
  });
});
