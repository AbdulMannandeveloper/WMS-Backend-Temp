/**
 * Location and class names are one name whatever the case.
 *
 * `Bin A1` and `BIN A1` on the same shelf are one place to anyone standing in
 * the warehouse, and they already shared a materialised path (a lowercase
 * slug), but the duplicate check and the unique index both compared exactly.
 * The names keep the case they were typed in; only matching ignores it.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import { makeAdmin, makeLocation, makeLocationClass } from '../factories/index.js';

/** A shelf (root class) holding bins (child class). */
const arrange = async () => {
  const admin = await makeAdmin();
  const shelfClass = await makeLocationClass();
  const binClass = await makeLocationClass({ parentClassId: shelfClass.id });
  const shelf = await makeLocation({ locationClassId: shelfClass.id });
  return { admin, shelfClass, binClass, shelf };
};

const createLocation = (actor, body) => as(actor).post('/api/warehouse-locations').send(body);

describe('location names', () => {
  it('refuses a sibling whose name differs only in case', async () => {
    const { admin, binClass, shelf } = await arrange();
    await makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'Bin A1' });

    const res = await createLocation(admin, {
      locationName: 'bin a1',
      locationClassId: binClass.id,
      parentLocationId: shelf.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('allows the same name in another case under a different parent', async () => {
    const { admin, shelfClass, binClass, shelf } = await arrange();
    const otherShelf = await makeLocation({ locationClassId: shelfClass.id });
    await makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'Bin A1' });

    const res = await createLocation(admin, {
      locationName: 'bin a1',
      locationClassId: binClass.id,
      parentLocationId: otherShelf.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.locationName).toBe('bin a1');
  });

  it('refuses a top-level name that differs only in case', async () => {
    // The database leaves NULL parents to the application, as it always has;
    // the application's check now ignores case like the index beneath it.
    const admin = await makeAdmin();
    const zoneClass = await makeLocationClass();
    await makeLocation({ locationClassId: zoneClass.id, locationName: 'Zone North' });

    const res = await createLocation(admin, { locationName: 'ZONE NORTH', locationClassId: zoneClass.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('refuses a rename onto a sibling in another case', async () => {
    const { admin, binClass, shelf } = await arrange();
    await makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'Bin B2' });
    const other = await makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'Bin B3' });

    const res = await as(admin).put(`/api/warehouse-locations/${other.id}`).send({ locationName: 'BIN b2' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('lets a location change the case of its own name', async () => {
    const { admin, binClass, shelf } = await arrange();
    const bin = await makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'bin c4' });

    const res = await as(admin).put(`/api/warehouse-locations/${bin.id}`).send({ locationName: 'Bin C4' });

    expect(res.status).toBe(200);
    expect(res.body.locationName).toBe('Bin C4');
  });
});

describe('class names', () => {
  it('refuses a class whose name differs only in case', async () => {
    const admin = await makeAdmin();
    await makeLocationClass({ name: 'Pallet Bay' });

    const res = await as(admin).post('/api/warehouse-location-classes').send({ name: 'pallet bay' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('lets a class change the case of its own name', async () => {
    const admin = await makeAdmin();
    const cls = await makeLocationClass({ name: 'cold store' });

    const res = await as(admin).put(`/api/warehouse-location-classes/${cls.id}`).send({ name: 'Cold Store' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Cold Store');
  });

  it('resolves a class given by name in another case', async () => {
    const admin = await makeAdmin();
    const cls = await makeLocationClass({ name: 'Mezzanine' });

    const res = await createLocation(admin, { locationName: 'Mezz 1', class: 'MEZZANINE' });

    expect(res.status).toBe(201);
    expect(res.body.locationClassId).toBe(cls.id);
  });
});

describe('the database rule', () => {
  it('refuses sibling locations that differ only in case', async () => {
    const { binClass, shelf } = await arrange();
    await makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'Raw Bin' });

    await expect(
      makeLocation({ locationClassId: binClass.id, parentLocationId: shelf.id, locationName: 'RAW BIN' }),
    ).rejects.toThrow(/uq_warehouse_locations_parent_name_ci|lower\(location_name/);
  });

  it('refuses classes that differ only in case', async () => {
    await makeLocationClass({ name: 'Raw Class' });

    await expect(makeLocationClass({ name: 'raw class' })).rejects.toThrow(
      /uq_warehouse_location_classes_name_ci|lower\(name/,
    );
  });
});
