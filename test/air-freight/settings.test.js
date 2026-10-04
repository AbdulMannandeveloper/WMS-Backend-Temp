/**
 * Per-client air freight billing & notification settings.
 *
 * A client with no row reads the defaults; saving validates the ranges that a
 * single price cannot express. These shape every invoice, so they are admin-only.
 * The old parcel freight module left no way to bill a client; this is where the
 * air freight rules are set before billing is switched on.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as, anon } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeAirFreightFlight,
  grantPermissions,
} from '../factories/index.js';

let admin;
let client;

beforeEach(async () => {
  admin = await makeAdmin();
  client = (await makeClient()).client;
});

describe('reading settings', () => {
  it('returns the defaults when the client has no row', async () => {
    const res = await as(admin).get(`/api/air-freight/client-settings/${client.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      chargeableWeightMethod: 'PER_BOX',
      volumetricDivisor: 6000,
      roundingIncrementKg: 0.5,
      freeStorageHours: 48,
      emailNotifications: false,
      isDefault: true,
    });
  });

  it('is admin-only and needs a session', async () => {
    const { user: employee } = await makeEmployee();
    await grantPermissions(employee, ['airfreight:read', 'airfreight:update']);
    expect((await as(employee).get(`/api/air-freight/client-settings/${client.id}`)).status).toBe(403);
    expect((await anon().get(`/api/air-freight/client-settings/${client.id}`)).status).toBe(401);
  });
});

describe('saving settings', () => {
  it('persists valid changes and reports isDefault false', async () => {
    const res = await as(admin).put(`/api/air-freight/client-settings/${client.id}`).send({
      chargeableWeightMethod: 'FLIGHT_TOTAL',
      volumetricDivisor: 5000,
      roundingIncrementKg: 1,
      freeStorageHours: 72,
      emailNotifications: true,
      notificationEmail: 'ops@client.test',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      chargeableWeightMethod: 'FLIGHT_TOTAL',
      volumetricDivisor: 5000,
      roundingIncrementKg: 1,
      freeStorageHours: 72,
      emailNotifications: true,
      notificationEmail: 'ops@client.test',
      isDefault: false,
    });

    const read = await as(admin).get(`/api/air-freight/client-settings/${client.id}`);
    expect(read.body.volumetricDivisor).toBe(5000);
  });

  it('refuses out-of-range values', async () => {
    const divisor = await as(admin)
      .put(`/api/air-freight/client-settings/${client.id}`)
      .send({ volumetricDivisor: 100 });
    expect(divisor.status).toBe(400);

    const rounding = await as(admin)
      .put(`/api/air-freight/client-settings/${client.id}`)
      .send({ roundingIncrementKg: 0.25 });
    expect(rounding.status).toBe(400);

    const method = await as(admin)
      .put(`/api/air-freight/client-settings/${client.id}`)
      .send({ chargeableWeightMethod: 'BY_VOLUME' });
    expect(method.status).toBe(400);

    const email = await as(admin)
      .put(`/api/air-freight/client-settings/${client.id}`)
      .send({ notificationEmail: 'not-an-email' });
    expect(email.status).toBe(400);
  });

  it('404s an unknown client', async () => {
    const res = await as(admin)
      .put('/api/air-freight/client-settings/11111111-1111-1111-1111-111111111111')
      .send({ freeStorageHours: 24 });
    expect(res.status).toBe(404);
  });
});

describe('deleting a client with air freight', () => {
  it('is blocked by a flight, with the flight named in the report', async () => {
    await makeAirFreightFlight(client.id);

    const res = await as(admin).delete(`/api/clients/${client.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_DEPENDENTS');
    expect(res.body.dependents.blocking.some((b) => b.key === 'airFreightFlights')).toBe(true);
  });
});
