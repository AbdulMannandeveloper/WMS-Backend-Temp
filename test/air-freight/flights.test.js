/**
 * Air freight flights — the DRAFT a client or staff creates, fills with boxes,
 * and dispatches.
 *
 * The flight reference and the box-status machine are the module's, not the
 * caller's: a flight gets an AF-YYYY-NNNNNN number it never types, and dispatch
 * is refused until the box list is real (a MAWB, at least one box, no half-done
 * upload). After dispatch the box list is locked. Clients act only on their own
 * flights, which is why cross-tenant reads answer 404 rather than 403.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeCourier,
  makeAirFreightBox,
  grantPermissions,
} from '../factories/index.js';

let admin;
let employee;
let clientUser;
let client;
let courier;

const AIRFREIGHT = ['airfreight:create', 'airfreight:read', 'airfreight:update', 'airfreight:delete'];

const draftBody = (overrides = {}) => ({
  clientId: client.id,
  originLocation: 'Lahore (LHE)',
  destinationLocation: 'London Heathrow (LHR)',
  mawbNumber: '176-12345675',
  ...overrides,
});

beforeEach(async () => {
  admin = await makeAdmin();
  const emp = await makeEmployee();
  employee = emp.user;
  await grantPermissions(employee, AIRFREIGHT);
  const c = await makeClient();
  clientUser = c.user;
  client = c.client;
  courier = await makeCourier({ code: 'UPS', name: 'UPS' });
});

describe('creating a flight', () => {
  it('issues an AF reference and starts in DRAFT', async () => {
    const res = await as(admin).post('/api/air-freight/flights').send(draftBody());
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^AF-\d{4}-\d{6}$/);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.clientId).toBe(client.id);
  });

  it('forces a client to their own id, ignoring any clientId they send', async () => {
    const other = (await makeClient()).client;
    const res = await as(clientUser)
      .post('/api/air-freight/flights')
      .send(draftBody({ clientId: other.id }));
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBe(client.id);
  });

  it('requires origin and destination', async () => {
    const res = await as(admin)
      .post('/api/air-freight/flights')
      .send({ clientId: client.id, originLocation: '' });
    expect(res.status).toBe(400);
  });

  it('needs a session', async () => {
    expect((await anon().post('/api/air-freight/flights').send(draftBody())).status).toBe(401);
  });
});

describe('editing a flight', () => {
  it('edits a DRAFT freely', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    const res = await as(admin)
      .patch(`/api/air-freight/flights/${flight.id}`)
      .send({ airline: 'PIA', flightNumber: 'PK757' });
    expect(res.status).toBe(200);
    expect(res.body.airline).toBe('PIA');
  });

  it('refuses an employee editing after dispatch, and an admin needs a reason', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    await makeAirFreightBox(flight.id, courier.id);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);

    const byEmployee = await as(employee)
      .patch(`/api/air-freight/flights/${flight.id}`)
      .send({ airline: 'Emirates' });
    expect(byEmployee.status).toBe(403);

    const noReason = await as(admin)
      .patch(`/api/air-freight/flights/${flight.id}`)
      .send({ airline: 'Emirates' });
    expect(noReason.status).toBe(400);

    const withReason = await as(admin)
      .patch(`/api/air-freight/flights/${flight.id}`)
      .send({ airline: 'Emirates', reason: 'Airline corrected by forwarder' });
    expect(withReason.status).toBe(200);
    expect(withReason.body.airline).toBe('Emirates');
  });
});

describe('dispatch', () => {
  it('refuses a flight with no boxes', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    expect(res.status).toBe(400);
  });

  it('refuses a flight with no MAWB', async () => {
    const { body: flight } = await as(admin)
      .post('/api/air-freight/flights')
      .send(draftBody({ mawbNumber: '' }));
    await makeAirFreightBox(flight.id, courier.id);
    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    expect(res.status).toBe(400);
  });

  it('dispatches a ready flight and moves its boxes to DISPATCHED', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    const box = await makeAirFreightBox(flight.id, courier.id);
    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPATCHED');

    const after = await as(admin).get(`/api/air-freight/boxes/${box.id}`);
    expect(after.body.status).toBe('DISPATCHED');
    expect(after.body.events.some((e) => e.eventType === 'DISPATCHED')).toBe(true);
  });

  it('refuses a second dispatch', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    await makeAirFreightBox(flight.id, courier.id);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    const res = await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);
    expect(res.status).toBe(409);
  });
});

describe('cancel', () => {
  it('is admin-only, needs a reason, and cancels the boxes', async () => {
    const { body: flight } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    const box = await makeAirFreightBox(flight.id, courier.id);
    await as(admin).post(`/api/air-freight/flights/${flight.id}/dispatch`);

    expect(
      (await as(employee).post(`/api/air-freight/flights/${flight.id}/cancel`).send({ reason: 'x' })).status,
    ).toBe(403);
    expect(
      (await as(admin).post(`/api/air-freight/flights/${flight.id}/cancel`).send({})).status,
    ).toBe(400);

    const res = await as(admin)
      .post(`/api/air-freight/flights/${flight.id}/cancel`)
      .send({ reason: 'Recalled before departure' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    const after = await as(admin).get(`/api/air-freight/boxes/${box.id}`);
    expect(after.body.status).toBe('CANCELLED');
  });
});

describe('list, summary and delete', () => {
  it('lists with a paginated envelope and summarises by status', async () => {
    await as(admin).post('/api/air-freight/flights').send(draftBody());
    const list = await as(admin).get('/api/air-freight/flights');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.pagination.total).toBeGreaterThanOrEqual(1);

    const summary = await as(admin).get('/api/air-freight/flights/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.DRAFT).toBeGreaterThanOrEqual(1);
  });

  it('deletes a DRAFT but blocks a dispatched flight with the dependents report', async () => {
    const { body: draft } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    expect((await as(admin).delete(`/api/air-freight/flights/${draft.id}`)).status).toBe(200);

    const { body: live } = await as(admin).post('/api/air-freight/flights').send(draftBody());
    await makeAirFreightBox(live.id, courier.id);
    await as(admin).post(`/api/air-freight/flights/${live.id}/dispatch`);
    const res = await as(admin).delete(`/api/air-freight/flights/${live.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_DEPENDENTS');
  });
});

describe('client scoping', () => {
  it('hides another client\'s flight behind a 404', async () => {
    const { body: mine } = await as(clientUser).post('/api/air-freight/flights').send(draftBody());
    const otherClient = await makeClient();
    expect((await as(otherClient.user).get(`/api/air-freight/flights/${mine.id}`)).status).toBe(404);
    expect((await as(clientUser).get(`/api/air-freight/flights/${mine.id}`)).status).toBe(200);
  });
});
