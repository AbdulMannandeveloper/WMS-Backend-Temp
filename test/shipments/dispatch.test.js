/**
 * Creating a shipment now dispatches it.
 *
 * The three-step walk described a process that had already happened: the parcel
 * is packed and labelled before anyone opens the screen. So creation takes the
 * stock out and raises the charge in one act.
 *
 * Two of these fail against the old code by design. An admin could not create a
 * shipment at all, because the creator was an Employee and neither admin
 * account has an Employee row. And the client was chosen before the goods,
 * which let a shipment carry two clients' stock.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as, anon } from '../helpers/auth.js';
import shipmentLogic from '../../logic/shipment.logic.js';
import {
  makeWarehouseScenario,
  makeClient,
  makeProduct,
  makeStockLevel,
  makeShipmentRate,
} from '../factories/index.js';

const arrange = async ({ quantity = 100 } = {}) => {
  const scenario = await makeWarehouseScenario({ quantity });
  return scenario;
};

const post = (actor, body) => as(actor).post('/api/shipments').send(body);

const oneLine = (scenario, quantity = 2) => [
  {
    productId: scenario.product.id,
    sourceLocationId: scenario.location.id,
    quantity,
  },
];

const onHand = async (productId) => {
  const { _sum } = await prisma.stockLevel.aggregate({
    where: { productId },
    _sum: { currentQuantity: true },
  });
  return _sum.currentQuantity ?? 0;
};

describe('the scanned label', () => {
  it('is required', async () => {
    const s = await arrange();

    const res = await post(s.admin, { shipmentItems: oneLine(s) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/label/i);
  });

  it('is stored on the shipment', async () => {
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-2026-0042',
      shipmentItems: oneLine(s),
    });

    expect(res.status).toBe(201);
    expect(res.body.reference).toBe('SHP-2026-0042');
  });

  it('cannot be used twice, and the refusal names the earlier one', async () => {
    // Two shipments sharing an identity cannot be told apart afterwards by the
    // warehouse, the courier, or a client querying the invoice line.
    const s = await arrange();
    await post(s.admin, { reference: 'SHP-DUP', shipmentItems: oneLine(s, 1) });

    const res = await post(s.admin, {
      reference: 'SHP-DUP',
      shipmentItems: oneLine(s, 1),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SHP-DUP/);
    expect(res.body.error).toMatch(/already used/i);
  });

  it('is trimmed, so a trailing newline from a scanner does not make a new label', async () => {
    const s = await arrange();
    await post(s.admin, { reference: 'SHP-TRIM', shipmentItems: oneLine(s, 1) });

    const res = await post(s.admin, {
      reference: '  SHP-TRIM  ',
      shipmentItems: oneLine(s, 1),
    });

    expect(res.status).toBe(400);
  });
});

describe('who creates it', () => {
  it('lets an admin create one — they have no Employee row', async () => {
    // This is the case that fails against the old code. employeeId was a
    // required foreign key to Employee, and an admin is not an employee.
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-ADMIN',
      shipmentItems: oneLine(s),
    });

    expect(res.status).toBe(201);
    expect(res.body.createdByUserId).toBe(s.admin.id);
  });

  it('lets an employee create one', async () => {
    const s = await arrange();

    const res = await post(s.employeeUser, {
      reference: 'SHP-EMP',
      shipmentItems: oneLine(s),
    });

    expect(res.status).toBe(201);
    expect(res.body.createdByUserId).toBe(s.employeeUser.id);
  });

  it('ignores a creator claimed in the body', async () => {
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-SPOOF',
      createdByUserId: s.employeeUser.id,
      shipmentItems: oneLine(s),
    });

    expect(res.body.createdByUserId).toBe(s.admin.id);
  });

  it('refuses an unauthenticated request', async () => {
    const s = await arrange();

    const res = await anon()
      .post('/api/shipments')
      .send({ reference: 'SHP-ANON', shipmentItems: oneLine(s) });

    expect([401, 403]).toContain(res.status);
  });
});

describe('the client comes from the goods', () => {
  it('is derived, not asked for', async () => {
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-DERIVED',
      shipmentItems: oneLine(s),
    });

    expect(res.body.clientId).toBe(s.client.id);
  });

  it('cannot be overridden through the API', async () => {
    // Otherwise the goods would go out under one client and bill another.
    // Guarded twice: the controller allowlist never passes clientId on, and
    // the logic derives it regardless. This covers the outer one.
    const s = await arrange();
    const { client: other } = await makeClient();

    const res = await post(s.admin, {
      reference: 'SHP-OVERRIDE',
      clientId: other.id,
      shipmentItems: oneLine(s),
    });

    expect(res.body.clientId).toBe(s.client.id);
  });

  it('cannot be overridden in the logic either, with the allowlist bypassed', async () => {
    // The inner guard, tested directly. A mutation that made the logic honour
    // a body clientId passed every HTTP test, because the allowlist had
    // already stripped it — so the second line of defence was untested and
    // would have been the only one left if the allowlist ever widened.
    const s = await arrange();
    const { client: other } = await makeClient();

    const created = await shipmentLogic.createShipment(
      {
        reference: 'SHP-LOGIC-OVERRIDE',
        clientId: other.id,
        shipmentItems: oneLine(s),
      },
      s.admin.id,
    );

    expect(created.clientId).toBe(s.client.id);
  });

  it('refuses goods belonging to two clients, and names the product', async () => {
    const s = await arrange();
    const { client: other } = await makeClient();
    const foreign = await makeProduct(other.id, { productName: 'Someone Elses Tape' });
    await makeStockLevel(foreign.id, s.location.id, { currentQuantity: 50 });

    const res = await post(s.admin, {
      reference: 'SHP-MIXED',
      shipmentItems: [
        ...oneLine(s, 1),
        { productId: foreign.id, sourceLocationId: s.location.id, quantity: 1 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Someone Elses Tape/);
    expect(res.body.error).toMatch(/one client/i);
  });

  it('creates nothing when the goods disagree', async () => {
    const s = await arrange();
    const { client: other } = await makeClient();
    const foreign = await makeProduct(other.id);
    await makeStockLevel(foreign.id, s.location.id, { currentQuantity: 50 });

    await post(s.admin, {
      reference: 'SHP-MIXED-2',
      shipmentItems: [
        ...oneLine(s, 1),
        { productId: foreign.id, sourceLocationId: s.location.id, quantity: 1 },
      ],
    });

    expect(await prisma.shipment.count({ where: { reference: 'SHP-MIXED-2' } })).toBe(0);
  });

  it('carries several different products belonging to the same client', async () => {
    // Ported from the old create.test.js, which otherwise described a contract
    // that no longer exists. A mixed shipment is refused only when the clients
    // differ — several of one client's products is the ordinary case.
    const s = await arrange();
    const second = await makeProduct(s.client.id, { productName: 'Bubble Wrap' });
    await makeStockLevel(second.id, s.location.id, { currentQuantity: 40 });

    const res = await post(s.admin, {
      reference: 'SHP-MULTI',
      shipmentItems: [
        { productId: s.product.id, sourceLocationId: s.location.id, quantity: 2 },
        { productId: second.id, sourceLocationId: s.location.id, quantity: 3 },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.shipmentItems).toHaveLength(2);
    expect(res.body.clientId).toBe(s.client.id);
  });

  it('refuses an empty shipment', async () => {
    const s = await arrange();

    const res = await post(s.admin, { reference: 'SHP-EMPTY', shipmentItems: [] });
    expect(res.status).toBe(400);
  });
});

describe('creating dispatches it', () => {
  it('leaves the shipment DISPATCHED', async () => {
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-STATUS',
      shipmentItems: oneLine(s),
    });

    expect(res.body.status).toBe('DISPATCHED');
  });

  it('takes the stock off the shelf', async () => {
    const s = await arrange({ quantity: 10 });

    await post(s.admin, { reference: 'SHP-STOCK', shipmentItems: oneLine(s, 4) });

    expect(await onHand(s.product.id)).toBe(6);
  });

  it('writes a CHECKOUT movement against the person signed in', async () => {
    const s = await arrange();

    await post(s.admin, { reference: 'SHP-LEDGER', shipmentItems: oneLine(s, 3) });

    const movement = await prisma.inventoryLedger.findFirst({
      where: { productId: s.product.id, movementType: 'CHECKOUT' },
    });
    expect(movement.quantity).toBe(3);
    expect(movement.userId).toBe(s.admin.id);
  });

  it('raises one invoice line, priced per item', async () => {
    const s = await arrange();
    await makeShipmentRate(s.client.id, '2.00');

    await post(s.admin, { reference: 'SHP-BILL', shipmentItems: oneLine(s, 5) });

    const lines = await prisma.invoiceLineItem.findMany({
      where: { itemType: 'SHIPMENT_CHARGE' },
    });
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].quantity)).toBe(5);
    expect(Number(lines[0].totalPrice)).toBe(10);
    // Names the scanned label, which is what is written on the parcel.
    expect(lines[0].description).toMatch(/SHP-BILL/);
  });

  it('still ships a client who has no dispatch rate, without opening an empty invoice', async () => {
    // A services-only client is a real arrangement, not an error.
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-NORATE',
      shipmentItems: oneLine(s),
    });

    expect(res.status).toBe(201);
    expect(await prisma.monthlyInvoice.count({ where: { clientId: s.client.id } })).toBe(0);
  });

  it('ignores billable services in the body rather than silently charging them', async () => {
    // They are raised from the Clients screen now. Accepting them here would be
    // a way around that, and a charge nobody goes looking for.
    const s = await arrange();

    const res = await post(s.admin, {
      reference: 'SHP-SERVICES',
      shipmentItems: oneLine(s),
      shipmentServices: [{ serviceId: '00000000-0000-0000-0000-000000000000', quantity: 1 }],
    });

    expect(res.status).toBe(201);
    expect(await prisma.shipmentServiceMapping.count()).toBe(0);
  });

  it('rolls everything back when a line cannot be reserved', async () => {
    const s = await arrange({ quantity: 1 });

    const res = await post(s.admin, {
      reference: 'SHP-ROLLBACK',
      shipmentItems: oneLine(s, 99),
    });

    expect(res.status).toBe(400);
    expect(await prisma.shipment.count({ where: { reference: 'SHP-ROLLBACK' } })).toBe(0);
    expect(await onHand(s.product.id)).toBe(1);
  });
});
