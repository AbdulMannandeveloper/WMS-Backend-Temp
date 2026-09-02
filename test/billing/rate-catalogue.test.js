/**
 * The two services the system raises for itself.
 *
 * SHIPMENT_DISPATCH and FBA_DISPATCH are priced per client through the ordinary
 * rate card, which means they have to exist as catalogue rows before anyone can
 * set a price against them. They did not. Both ensure* helpers were written and
 * neither was ever called, so the codes were absent from the database, absent
 * from the Clients → Services dropdown, and no shipment or FBA consignment had
 * ever been chargeable — while the whole billing suite passed, because its
 * fixtures create the rows themselves.
 *
 * server.js seeds them on boot now. These tests hold that the helpers stay
 * idempotent and keep the shape the billing code depends on.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import billingServices from '../../logic/billing_services.js';

const {
  ensureShipmentService,
  ensureFbaService,
  SHIPMENT_SERVICE_CODE,
  FBA_SERVICE_CODE,
} = billingServices;

describe('seeding the catalogue', () => {
  it('creates the dispatch service when it is missing', async () => {
    const created = await ensureShipmentService();

    expect(created.code).toBe(SHIPMENT_SERVICE_CODE);
    expect(
      await prisma.service.count({ where: { code: SHIPMENT_SERVICE_CODE } })
    ).toBe(1);
  });

  it('creates the FBA service when it is missing', async () => {
    const created = await ensureFbaService();

    expect(created.code).toBe(FBA_SERVICE_CODE);
    expect(await prisma.service.count({ where: { code: FBA_SERVICE_CODE } })).toBe(1);
  });

  it('running twice does not create a second row', async () => {
    // Every worker runs this on boot, and the code column is unique — a second
    // insert would crash the process on startup rather than being harmless.
    await ensureShipmentService();
    await ensureShipmentService();
    await ensureShipmentService();

    expect(
      await prisma.service.count({ where: { code: SHIPMENT_SERVICE_CODE } })
    ).toBe(1);
  });

  it('leaves an existing row alone rather than resetting its price', async () => {
    // The list price is editable by an admin. Re-seeding must not undo that.
    await ensureShipmentService();
    await prisma.service.update({
      where: { code: SHIPMENT_SERVICE_CODE },
      data: { ideaPrice: '4.50', description: 'Renamed by an admin' },
    });

    await ensureShipmentService();

    const after = await prisma.service.findUnique({
      where: { code: SHIPMENT_SERVICE_CODE },
    });
    expect(Number(after.ideaPrice)).toBe(4.5);
    expect(after.description).toBe('Renamed by an admin');
  });

  it('gives both services the unit the billing code assumes', async () => {
    // Both are multiplied by an item count, so anything but "item" would make
    // the invoice line read as nonsense.
    const shipment = await ensureShipmentService();
    const fba = await ensureFbaService();

    expect(shipment.unit).toBe('item');
    expect(fba.unit).toBe('item');
  });

  it('keeps them distinct, so one rate cannot be mistaken for the other', async () => {
    const shipment = await ensureShipmentService();
    const fba = await ensureFbaService();

    expect(shipment.id).not.toBe(fba.id);
    expect(SHIPMENT_SERVICE_CODE).not.toBe(FBA_SERVICE_CODE);
  });
});

describe('what an admin sees to price', () => {
  it('both appear in the ordinary service list the rate-card screen reads', async () => {
    // Clients → Services lists every Service. If these are not in it there is
    // nowhere in the product to set a dispatch price at all.
    await ensureShipmentService();
    await ensureFbaService();

    const catalogue = await prisma.service.findMany();
    const codes = catalogue.map((s) => s.code).filter(Boolean);

    expect(codes).toContain(SHIPMENT_SERVICE_CODE);
    expect(codes).toContain(FBA_SERVICE_CODE);
  });
});
