/**
 * Inventory under permission control.
 *
 * Employees used to create and edit products, stock rows and ledger entries
 * freely, and could delete none of them. Now each of the four actions is
 * granted individually, and a granted delete opens routes that were admin-only.
 *
 * The cache test at the bottom is the one that could not be written until a
 * route was governed — it is the first thing here that actually reads
 * req.user.permissions, and therefore the first that can notice a stale cache.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { as } from '../helpers/auth.js';
import {
  makeAdmin,
  makeEmployee,
  makeClient,
  makeProduct,
  makeLocation,
  makeStockLevel,
} from '../factories/index.js';

let admin;
let employee;
let employeeUser;
let client;
let product;
let location;

/** Grants exactly this set to the employee under test. */
const grant = async (...permissions) => {
  const res = await as(admin)
    .put(`/api/employees/${employee.id}/permissions`)
    .send({ permissions });
  expect(res.status).toBe(200);
};

beforeEach(async () => {
  admin = await makeAdmin();
  const made = await makeEmployee();
  employee = made.employee;
  employeeUser = made.user;
  client = (await makeClient()).client;
  product = await makeProduct(client.id);
  location = await makeLocation();
});

describe('an employee holding nothing', () => {
  it('is refused every inventory route', async () => {
    const calls = [
      as(employeeUser).get('/api/products'),
      as(employeeUser).get('/api/stock'),
      as(employeeUser).get('/api/inventory-ledgers'),
      as(employeeUser).post('/api/products').send({}),
      as(employeeUser).post('/api/stock').send({}),
      as(employeeUser).put(`/api/products/${product.id}`).send({}),
      as(employeeUser).delete(`/api/products/${product.id}`),
    ];

    for (const call of calls) {
      await expect(call.then((r) => r.status)).resolves.toBe(403);
    }
  });
});

describe('read', () => {
  it('opens the lists, and nothing else', async () => {
    await grant('inventory:read');

    expect((await as(employeeUser).get('/api/products')).status).toBe(200);
    expect((await as(employeeUser).get('/api/stock')).status).toBe(200);
    expect((await as(employeeUser).get('/api/inventory-ledgers')).status).toBe(200);
    expect((await as(employeeUser).get('/api/stock/summary')).status).toBe(200);
    expect(
      (await as(employeeUser).get(`/api/products/${product.id}/stock`)).status,
    ).toBe(200);

    // Reading does not imply writing.
    expect(
      (await as(employeeUser).post('/api/products').send({})).status,
    ).toBe(403);
  });

  it('covers the barcode lookup the scanner uses', async () => {
    await grant('inventory:read');

    const res = await as(employeeUser).get(
      '/api/products/lookup/barcode/NOTHING-HERE',
    );

    // 404 rather than 403: the route was reached, the barcode simply is not one.
    expect(res.status).not.toBe(403);
  });
});

describe('create', () => {
  it('opens registering a product, a stock row and a movement', async () => {
    await grant('inventory:create', 'inventory:read');

    const created = await as(employeeUser)
      .post('/api/products')
      .send({
        clientId: client.id,
        skuCode: 'PERM-SKU-1',
        productName: 'Permitted Widget',
      });
    expect(created.status).toBe(201);

    // Opened empty: units arrive only by a movement, like the one below.
    const stock = await as(employeeUser)
      .post('/api/stock')
      .send({ productId: created.body.id, locationId: location.id });
    expect(stock.status).toBe(201);

    const movement = await as(employeeUser)
      .post('/api/inventory-ledgers')
      .send({
        productId: created.body.id,
        userId: employeeUser.id,
        movementType: 'CHECKIN',
        quantity: 3,
        toLocationId: location.id,
      });
    expect(movement.status).toBe(201);
  });

  it('does not open editing or deleting', async () => {
    await grant('inventory:create');

    expect(
      (await as(employeeUser).put(`/api/products/${product.id}`).send({ productName: 'x' })).status,
    ).toBe(403);
    expect(
      (await as(employeeUser).delete(`/api/products/${product.id}`)).status,
    ).toBe(403);
  });
});

describe('update', () => {
  it('opens editing a product, and reaches the stock-row edit', async () => {
    const stock = await makeStockLevel(product.id, location.id, {
      currentQuantity: 10,
    });
    await grant('inventory:update', 'inventory:read');

    const edited = await as(employeeUser)
      .put(`/api/products/${product.id}`)
      .send({ productName: 'Renamed Widget' });
    expect(edited.status).toBe(200);

    // Through the gate — then refused for everyone, because a count changes
    // only by a stock movement (test/inventory/stock-rows.test.js).
    const adjusted = await as(employeeUser)
      .put(`/api/stock/${stock.id}`)
      .send({ currentQuantity: 12 });
    expect(adjusted.status).toBe(409);
  });

  it('covers deactivating, which is reversible and is floor work', async () => {
    await grant('inventory:update');

    const res = await as(employeeUser).patch(`/api/products/${product.id}`);

    expect(res.status).not.toBe(403);
  });

  it('does not open deleting', async () => {
    await grant('inventory:update');

    expect(
      (await as(employeeUser).delete(`/api/products/${product.id}`)).status,
    ).toBe(403);
  });
});

describe('delete, which no employee could do before', () => {
  it('opens removing a product', async () => {
    await grant('inventory:delete');

    const res = await as(employeeUser).delete(`/api/products/${product.id}`);

    // Reached the handler. Whether it succeeds depends on the delete guard —
    // a product with movements against it is refused on its merits, not on
    // who asked.
    expect(res.status).not.toBe(403);
  });

  it('opens the warning shown before removing a product, to the same people', async () => {
    await grant('inventory:delete');
    expect(
      (await as(employeeUser).get(`/api/products/${product.id}/dependents`)).status,
    ).toBe(200);

    await grant('inventory:update');
    expect(
      (await as(employeeUser).get(`/api/products/${product.id}/dependents`)).status,
    ).toBe(403);
  });

  it('opens removing a stock row', async () => {
    const stock = await makeStockLevel(product.id, location.id);
    await grant('inventory:delete');

    const res = await as(employeeUser).delete(`/api/stock/${stock.id}`);

    expect(res.status).not.toBe(403);
  });

  it('does not open creating or editing', async () => {
    await grant('inventory:delete');

    expect((await as(employeeUser).post('/api/products').send({})).status).toBe(403);
    expect(
      (await as(employeeUser).put(`/api/products/${product.id}`).send({})).status,
    ).toBe(403);
  });
});

describe('a permission on one module does not reach another', () => {
  it('inventory:create does not create a shipment or an FBA arrival', async () => {
    await grant('inventory:create', 'inventory:read');

    // Those routes are governed in their own commits; this asserts the
    // vocabulary is per-module rather than a single staff flag.
    const { holdsPermission } = await import('../../utils/permissions.js');
    const actor = { role: 'employee', permissions: ['inventory:create'] };

    expect(holdsPermission(actor, 'inventory', 'create')).toBe(true);
    expect(holdsPermission(actor, 'shipments', 'create')).toBe(false);
    expect(holdsPermission(actor, 'fba', 'create')).toBe(false);
  });
});

describe('an admin', () => {
  it('does everything while holding nothing', async () => {
    const stock = await makeStockLevel(product.id, location.id);

    expect((await as(admin).get('/api/products')).status).toBe(200);
    // Past the gate; a count is refused to an admin too, as a ledger matter.
    expect(
      (await as(admin).put(`/api/stock/${stock.id}`).send({ currentQuantity: 1 })).status,
    ).toBe(409);
    expect((await as(admin).delete(`/api/stock/${stock.id}`)).status).not.toBe(403);
  });
});

describe('a client', () => {
  it('still reads its own stock without holding a permission', async () => {
    const { user: clientUser, client: ownClient } = await makeClient();
    const ownProduct = await makeProduct(ownClient.id);
    await makeStockLevel(ownProduct.id, location.id, { currentQuantity: 4 });

    const res = await as(clientUser).get('/api/stock');

    // Client access is narrowed by clientScope, not by this list. Asking a
    // client for inventory:read would have closed the portal.
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
  });

  it('still reads its own products and ledger', async () => {
    const { user: clientUser, client: ownClient } = await makeClient();
    await makeProduct(ownClient.id);

    expect((await as(clientUser).get('/api/products')).status).toBe(200);
    expect(
      (await as(clientUser).get(`/api/inventory-ledgers/client/${ownClient.id}`)).status,
    ).toBe(200);
  });
});

describe('the cache, which is how this fails silently', () => {
  it('a grant is live on the very next request, with the same token', async () => {
    // Read once so the pre-grant user row is cached, the way a live session
    // would have cached it long before an admin pressed save.
    const before = await as(employeeUser).get('/api/products');
    expect(before.status).toBe(403);

    await grant('inventory:read');

    const after = await as(employeeUser).get('/api/products');

    // Without invalidateCachedUser in setEmployeePermissions, req.user carries
    // the stale permission list and this is still 403 for up to
    // AUTH_USER_CACHE_TTL_MS — then starts passing on its own, per worker.
    expect(after.status).toBe(200);
  });

  it('a revocation takes effect just as immediately', async () => {
    await grant('inventory:read');
    expect((await as(employeeUser).get('/api/products')).status).toBe(200);

    await grant();

    expect((await as(employeeUser).get('/api/products')).status).toBe(403);
  });
});
