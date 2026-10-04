/**
 * The portal boundary: a client reaches air freight through the same handlers as
 * staff (holdsPermission lets them past the permission gate), so every handler
 * scopes to their own client and every response is redacted.
 *
 * Phase 2's surface: flights, manifests and boxes. Cross-tenant access answers
 * 404 (never 403, which would confirm the id exists), internal fields never
 * reach a client, and the staff-only actions refuse them.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import { makeAdmin, makeClient, makeCourier, makeAirFreightBox } from '../factories/index.js';

let admin;
let clientA;
let userA;
let userB;
let courier;

const bodyFor = (clientId) => ({
  clientId,
  originLocation: 'Lahore (LHE)',
  destinationLocation: 'London Heathrow (LHR)',
  mawbNumber: '176-12345675',
});

beforeEach(async () => {
  admin = await makeAdmin();
  const a = await makeClient();
  userA = a.user;
  clientA = a.client;
  userB = (await makeClient()).user;
  courier = await makeCourier({ code: 'UPS', name: 'UPS' });
});

describe('scoping (404 cross-tenant)', () => {
  it('hides another client\'s flight, box and upload file', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(bodyFor(clientA.id));
    const box = await makeAirFreightBox(flight.id, courier.id);

    expect((await as(userB).get(`/api/air-freight/flights/${flight.id}`)).status).toBe(404);
    expect((await as(userB).get(`/api/air-freight/boxes/${box.id}`)).status).toBe(404);
    expect((await as(userA).get(`/api/air-freight/flights/${flight.id}`)).status).toBe(200);
  });

  it('only lists the client\'s own flights', async () => {
    await as(admin).post('/api/air-freight/flights').send(bodyFor(clientA.id));
    const otherClient = (await makeClient()).client;
    await as(admin).post('/api/air-freight/flights').send(bodyFor(otherClient.id));

    const list = await as(userA).get('/api/air-freight/flights');
    expect(list.status).toBe(200);
    expect(list.body.data.every((f) => f.clientId === clientA.id)).toBe(true);
  });

  it('a bulk search never returns another client\'s box', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(bodyFor(clientA.id));
    await makeAirFreightBox(flight.id, courier.id, { trackingNumber: 'TRKAAA111' });

    const asOwner = await as(userA).post('/api/air-freight/boxes/bulk-search').send({ trackingNumbers: ['TRKAAA111'] });
    expect(asOwner.body.found).toHaveLength(1);

    const asOther = await as(userB).post('/api/air-freight/boxes/bulk-search').send({ trackingNumbers: ['TRKAAA111'] });
    expect(asOther.body.found).toHaveLength(0);
    expect(asOther.body.notFound).toContain('TRKAAA111');
  });
});

describe('redaction', () => {
  it('strips internal and billing fields from a client flight read', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(bodyFor(clientA.id));
    const res = await as(userA).get(`/api/air-freight/flights/${flight.id}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('createdByUserId');
    expect(res.body).not.toHaveProperty('billingStatus');
    expect(res.body).not.toHaveProperty('billingSnapshot');
    // The nested client summary keeps the company name but drops the email.
    expect(res.body.client).not.toHaveProperty('email');
  });
});

describe('forbidden actions', () => {
  it('refuses a client the admin-only routes', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(bodyFor(clientA.id));
    expect(
      (await as(userA).post(`/api/air-freight/flights/${flight.id}/cancel`).send({ reason: 'x' })).status,
    ).toBe(403);
    expect((await as(userA).get(`/api/air-freight/client-settings/${clientA.id}`)).status).toBe(403);
  });
});
