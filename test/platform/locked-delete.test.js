/**
 * The lock every checked delete takes before it counts what depends on it.
 *
 * A delete used to count dependents, then delete in a separate step. Anything
 * added in between was never counted: a cascading row went silently with the
 * record, and a stock row filled meanwhile was deleted as "empty".
 *
 * What must hold:
 *   - While a delete holds the row, a record that would name it waits, and
 *     once the delete commits it is refused — never silently attached to a
 *     record that is gone.
 *   - An id that is not a uuid locks nothing, so the lookup after it answers
 *     as it always did.
 */

import { describe, it, expect } from 'vitest';

import { prisma } from '../helpers/db.js';
import { makeClient, makeLocation, makeProduct, makeStockLevel } from '../factories/index.js';
import dependents from '../../utils/dependents.js';

const { lockForDelete } = dependents;

describe('lockForDelete', () => {
  it('holds back a dependent added while the delete is deciding', async () => {
    const { client } = await makeClient();
    const product = await makeProduct(client.id);
    const location = await makeLocation();

    let locked;
    const lockTaken = new Promise((resolve) => { locked = resolve; });
    let decide;
    const deciding = new Promise((resolve) => { decide = resolve; });

    const deleting = prisma.$transaction(
      async (tx) => {
        await lockForDelete(tx, 'warehouse_locations', location.id);
        locked();
        await deciding;
        await tx.warehouseLocation.delete({ where: { id: location.id } });
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    const arriving = makeStockLevel(product.id, location.id, { currentQuantity: 5 }).then(
      () => 'added',
      () => 'refused',
    );
    const meanwhile = await Promise.race([
      arriving,
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(meanwhile).toBe('waiting');

    decide();
    await deleting;

    expect(await arriving).toBe('refused');
    expect(await prisma.stockLevel.count({ where: { productId: product.id } })).toBe(0);
  });

  it('locks nothing for an id that is not a uuid', async () => {
    await expect(
      prisma.$transaction((tx) => lockForDelete(tx, 'warehouse_locations', 'not-a-uuid')),
    ).resolves.toBeUndefined();
  });
});
