/**
 * Proves the harness is real: the app boots without a listener, the database is
 * migrated and reachable, auth middleware runs, and fixtures are isolated
 * between tests.
 *
 * If this file passes, a failure anywhere else is a genuine finding rather than
 * a broken rig.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from './helpers/db.js';
import { as, anon } from './helpers/auth.js';
import { makeAdmin, makeUser, makeClient } from './factories/index.js';

describe('harness', () => {
  it('serves the liveness probe without a running listener', async () => {
    const res = await anon().get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reaches the migrated test database from the readiness probe', async () => {
    const res = await anon().get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('applied the migrations — core tables exist', async () => {
    const rows = await prisma.$queryRaw`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const tables = rows.map((r) => r.tablename);

    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'clients',
        'shipments',
        'monthly_invoices',
        'invoice_line_items',
        'stock_levels',
        'inventory_ledger',
      ])
    );
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await anon().get('/api/clients');

    expect(res.status).toBe(401);
  });

  it('rejects a non-admin on an admin-only route', async () => {
    const employee = await makeUser({ role: 'employee' });

    const res = await as(employee).get('/api/clients');

    expect(res.status).toBe(403);
  });

  it('accepts a minted admin token end to end', async () => {
    const admin = await makeAdmin();
    await makeClient({ companyName: 'Northwind Freight' });

    const res = await as(admin).get('/api/clients');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].companyName).toBe('Northwind Freight');
  });

  it('starts each test from an empty database', async () => {
    // The test above created a client. If truncation works, it is gone.
    await expect(prisma.client.count()).resolves.toBe(0);
    await expect(prisma.user.count()).resolves.toBe(0);
  });
});
