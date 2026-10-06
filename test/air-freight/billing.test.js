/**
 * Posting a flight's charges to the client's monthly invoice, and taking them
 * back off. Posting a not-completed flight needs a reason; unposting is refused
 * once a charge sits on a PAID invoice; a draft invoice holding air freight
 * charges cannot be deleted until they are unposted.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { prisma } from '../../lib/prisma.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeCourier, makeAirFreightFlight, makeAirFreightBox } from '../factories/index.js';

let admin;
let client;

const seedRate = async (code, price) => {
  const service = await prisma.service.upsert({
    where: { code }, update: {}, create: { code, description: code, ideaPrice: '0.00', unit: 'unit' },
  });
  await prisma.clientService.create({ data: { clientId: client.id, serviceId: service.id, chargedPrice: String(price), unit: 'unit' } });
};

const receivedFlight = async () => {
  const courier = await makeCourier();
  const flight = await makeAirFreightFlight(client.id, { mawbNumber: '176-12345675', status: 'LANDED', landedAt: new Date() });
  await makeAirFreightBox(flight.id, courier.id, { status: 'RECEIVED', receivedAt: new Date('2026-10-10T09:00:00Z') });
  await makeAirFreightBox(flight.id, courier.id, { status: 'RECEIVED', receivedAt: new Date('2026-10-10T09:00:00Z') });
  return flight;
};

beforeEach(async () => {
  admin = await makeAdmin();
  client = (await makeClient()).client;
  await seedRate('AIRFREIGHT_PER_KG', '0.80');
  await seedRate('AIRFREIGHT_PER_BOX', '1.50');
});

describe('statement', () => {
  it('shows live lines before posting', async () => {
    const flight = await receivedFlight();
    const res = await as(admin).get(`/api/air-freight/flights/${flight.id}/billing`);
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(false);
    expect(res.body.lines.length).toBeGreaterThan(0);
    expect(res.body.lines.some((l) => l.code === 'AIRFREIGHT_PER_BOX')).toBe(true);
  });
});

describe('post / unpost', () => {
  it('posts to the invoice (needs a reason when not completed) and unposts', async () => {
    const flight = await receivedFlight();

    const noReason = await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/post`).send({});
    expect(noReason.status).toBe(400);

    const posted = await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/post`).send({ reason: 'retro bill' });
    expect(posted.status).toBe(200);
    expect(posted.body.posted).toBe(true);

    const lines = await prisma.invoiceLineItem.findMany({ where: { airFreightFlightId: flight.id } });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.itemType === 'AIR_FREIGHT_CHARGE')).toBe(true);

    // Posting again is refused.
    expect((await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/post`).send({ reason: 'again' })).status).toBe(409);

    // The draft invoice cannot be deleted while it holds these charges.
    const invoiceId = lines[0].invoiceId;
    const del = await as(admin).delete(`/api/monthly-invoices/${invoiceId}`);
    expect(del.status).toBe(409);

    // Unpost removes them.
    const unposted = await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/unpost`);
    expect(unposted.status).toBe(200);
    expect(await prisma.invoiceLineItem.count({ where: { airFreightFlightId: flight.id } })).toBe(0);
  });

  it('refuses unpost when a charge is on a PAID invoice', async () => {
    const flight = await receivedFlight();
    await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/post`).send({ reason: 'x' });
    const line = await prisma.invoiceLineItem.findFirst({ where: { airFreightFlightId: flight.id } });
    await prisma.monthlyInvoice.update({ where: { id: line.invoiceId }, data: { status: 'PAID' } });

    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/unpost`);
    expect(res.status).toBe(409);
  });

  it('blocks removing a box while posted; after unpost + remove, the re-posted total drops', async () => {
    const flight = await receivedFlight();
    const boxes = await prisma.airFreightBox.findMany({ where: { flightId: flight.id } });

    const posted = await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/post`).send({ reason: 'x' });
    const before = posted.body.totals.total;

    // Removing a box is refused while the flight is POSTED.
    expect((await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/remove`).send({ reason: 'damaged beyond use' })).status).toBe(409);

    await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/unpost`);
    expect((await as(admin).post(`/api/air-freight/boxes/${boxes[0].id}/remove`).send({ reason: 'damaged beyond use' })).status).toBe(200);

    const reposted = await as(admin).post(`/api/air-freight/flights/${flight.id}/billing/post`).send({ reason: 'x' });
    expect(reposted.body.totals.total).toBeLessThan(before);
  });
});
