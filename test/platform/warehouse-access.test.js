/**
 * Who may work with the warehouse layout.
 *
 * Employees have full access. They are the ones who find a shelf full, need a
 * bin at the end of an aisle, or spot a location labelled wrongly — and making
 * them fetch an admin mid-shift to record what they are already looking at is
 * how the map drifts out of step with the building.
 *
 * Clients stay out entirely: where our racking is has nothing to do with them.
 */

import { describe, it, expect } from 'vitest';

import { as, anon } from '../helpers/auth.js';
import { makeWarehouseScenario, makeLocationClass } from '../factories/index.js';

describe('an employee', () => {
  it('can list locations', async () => {
    const { employeeUser } = await makeWarehouseScenario();
    expect((await as(employeeUser).get('/api/warehouse-locations')).status).toBe(200);
  });

  it('can read the tree', async () => {
    const { employeeUser } = await makeWarehouseScenario();
    expect((await as(employeeUser).get('/api/warehouse-locations/tree')).status).toBe(200);
  });

  it('can create a location', async () => {
    const { employeeUser } = await makeWarehouseScenario();
    const cls = await makeLocationClass();

    const res = await as(employeeUser)
      .post('/api/warehouse-locations')
      .send({ locationName: 'Aisle 9 Bin 3', classId: cls.id });

    expect(res.status).toBe(201);
  });

  it('can update a location', async () => {
    const { employeeUser, location } = await makeWarehouseScenario();

    const res = await as(employeeUser)
      .put(`/api/warehouse-locations/${location.id}`)
      .send({ locationName: 'Renamed by staff' });

    expect(res.status).toBe(200);
  });

  it('can read and create location classes, which the page needs', async () => {
    // The locations screen renders the class ladder, so closing classes to
    // employees would leave the page half-broken for them.
    const { employeeUser } = await makeWarehouseScenario();

    expect((await as(employeeUser).get('/api/warehouse-location-classes')).status).toBe(200);
    expect(
      (await as(employeeUser)
        .post('/api/warehouse-location-classes')
        .send({ name: 'Mezzanine' })).status
    ).toBe(201);
  });
});

describe('a client', () => {
  it('cannot see the warehouse layout', async () => {
    const { clientUser } = await makeWarehouseScenario();

    expect((await as(clientUser).get('/api/warehouse-locations')).status).toBe(403);
    expect((await as(clientUser).get('/api/warehouse-locations/tree')).status).toBe(403);
    expect((await as(clientUser).get('/api/warehouse-location-classes')).status).toBe(403);
  });

  it('cannot create one', async () => {
    const { clientUser } = await makeWarehouseScenario();
    const cls = await makeLocationClass();

    const res = await as(clientUser)
      .post('/api/warehouse-locations')
      .send({ locationName: 'Mine now', classId: cls.id });

    expect(res.status).toBe(403);
  });
});

describe('anonymous requests', () => {
  it('are refused', async () => {
    expect((await anon().get('/api/warehouse-locations')).status).toBe(401);
    expect((await anon().get('/api/warehouse-location-classes')).status).toBe(401);
  });
});
