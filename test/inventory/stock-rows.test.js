/**
 * The raw stock-row routes, /api/stock — which used to set quantities directly.
 *
 * A stock row's quantities are the running total of its ledger. These routes
 * let anyone with inventory update or delete change them with no movement to
 * say so: units appeared, or vanished, and nothing recorded why.
 *
 * What must hold:
 *   - An edit is refused, whatever it sends, and nothing changes.
 *   - A create opens an empty row only, and never in a deactivated location.
 *   - A delete takes only a row that holds nothing, and is logged.
 *   - The grants are unchanged: the same people reach the same routes.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { as } from '../helpers/auth.js';
import {
  grantPermissions,
  makeEmployee,
  makeLocation,
  makeStockLevel,
  makeWarehouseScenario,
} from '../factories/index.js';

const ledgerLines = () => prisma.inventoryLedger.count();
const stockOf = (id) => prisma.stockLevel.findUnique({ where: { id } });

describe('editing a stock row', () => {
  it('is refused, and changes nothing', async () => {
    const { admin, product, location, stock } = await makeWarehouseScenario();

    const byId = await as(admin)
      .put(`/api/stock/${stock.id}`)
      .send({ currentQuantity: 500, reservedQuantity: 3, arrivedTodayQuantity: 9 });
    const byPair = await as(admin)
      .put(`/api/stock/product/${product.id}/location/${location.id}`)
      .send({ currentQuantity: 0 });

    for (const res of [byId, byPair]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/only through stock movements/);
    }
    const after = await stockOf(stock.id);
    expect(after.currentQuantity).toBe(stock.currentQuantity);
    expect(after.reservedQuantity).toBe(stock.reservedQuantity);
    expect(after.arrivedTodayQuantity).toBe(stock.arrivedTodayQuantity);
  });

  it('is not found for a row that does not exist', async () => {
    const { admin, product } = await makeWarehouseScenario();
    const elsewhere = await makeLocation();

    expect((await as(admin).put('/api/stock/00000000-0000-4000-8000-000000000000').send({})).status).toBe(404);
    expect(
      (await as(admin).put(`/api/stock/product/${product.id}/location/${elsewhere.id}`).send({})).status,
    ).toBe(404);
  });
});

describe('creating a stock row', () => {
  it('opens an empty one', async () => {
    const { admin, product } = await makeWarehouseScenario();
    const location = await makeLocation();

    const res = await as(admin).post('/api/stock').send({ productId: product.id, locationId: location.id });

    expect(res.status).toBe(201);
    expect(res.body.currentQuantity).toBe(0);
    expect(res.body.arrivedTodayQuantity).toBe(0);
  });

  it('refuses one that arrives with units', async () => {
    const { admin, product } = await makeWarehouseScenario();
    const location = await makeLocation();
    const before = await ledgerLines();

    const res = await as(admin)
      .post('/api/stock')
      .send({ productId: product.id, locationId: location.id, currentQuantity: 40 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only through stock movements/);
    expect(await prisma.stockLevel.count({ where: { locationId: location.id } })).toBe(0);
    expect(await ledgerLines()).toBe(before);
  });

  it('refuses a deactivated location', async () => {
    const { admin, product } = await makeWarehouseScenario();
    const retired = await makeLocation({ isActive: false });

    const res = await as(admin).post('/api/stock').send({ productId: product.id, locationId: retired.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivated/);
  });
});

describe('deleting a stock row', () => {
  it('is refused while it holds stock', async () => {
    const { admin, stock } = await makeWarehouseScenario();

    const res = await as(admin).delete(`/api/stock/${stock.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still holds/);
    expect(await stockOf(stock.id)).not.toBeNull();
  });

  it('takes an empty one, and logs it', async () => {
    const { admin, product } = await makeWarehouseScenario();
    const empty = await makeStockLevel(product.id, (await makeLocation()).id, { currentQuantity: 0 });

    const res = await as(admin).delete(`/api/stock/${empty.id}`);

    expect(res.status).toBe(200);
    expect(await stockOf(empty.id)).toBeNull();
    const log = await prisma.auditLog.findFirst({ where: { action: 'DELETE_STOCK_LEVEL' } });
    expect(JSON.parse(log.details)).toMatchObject({ stockLevelId: empty.id, productId: product.id });
  });

  it('is not found for a row that does not exist', async () => {
    const { admin } = await makeWarehouseScenario();

    expect((await as(admin).delete('/api/stock/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('who reaches these routes', () => {
  it('is unchanged: an employee needs the matching inventory grant', async () => {
    const { product } = await makeWarehouseScenario();
    const empty = await makeStockLevel(product.id, (await makeLocation()).id, { currentQuantity: 0 });
    const { user: without } = await makeEmployee({ user: { permissions: [] } });
    const { user: withDelete } = await makeEmployee();
    await grantPermissions(withDelete, 'inventory:delete');

    expect((await as(without).put(`/api/stock/${empty.id}`).send({})).status).toBe(403);
    expect((await as(without).delete(`/api/stock/${empty.id}`)).status).toBe(403);
    expect((await as(withDelete).delete(`/api/stock/${empty.id}`)).status).toBe(200);
  });
});
