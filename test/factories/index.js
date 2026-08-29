import '../load-env.js';

import { randomUUID } from 'node:crypto';

import prismaLib from '../../lib/prisma.js';

const { prisma } = prismaLib;

/**
 * Fixture builders. These write through Prisma directly rather than through the
 * logic layer — arranging state should not depend on the code under test, and
 * several logic-layer creators send email or enforce rules a test wants to skip.
 *
 * Every builder takes an overrides object so a test can pin the one field it
 * cares about and ignore the rest.
 */

let seq = 0;
const uniq = (prefix) => `${prefix}-${++seq}-${randomUUID().slice(0, 8)}`;

export const makeUser = async (overrides = {}) => {
  const n = uniq('user');
  return prisma.user.create({
    data: {
      firstName: 'Test',
      lastName: 'User',
      email: `${n}@example.test`,
      role: 'employee',
      isActive: true,
      ...overrides,
    },
  });
};

export const makeAdmin = (overrides = {}) =>
  makeUser({ role: 'admin', firstName: 'Ada', lastName: 'Admin', ...overrides });

/** Employee user + linked Employee row. Returns both. */
export const makeEmployee = async (overrides = {}) => {
  const { user: userOverrides = {}, ...employeeOverrides } = overrides;

  const user = await makeUser({
    role: 'employee',
    firstName: 'Eli',
    lastName: 'Employee',
    ...userOverrides,
  });

  const employee = await prisma.employee.create({
    data: {
      userId: user.id,
      // Passed explicitly: the application generates these numbers in code, so
      // the schema's dbgenerated() default is an untested path.
      employeeUniqueNumber: uniq('EMP').toUpperCase(),
      jobTitle: 'Warehouse Operative',
      baseSalary: '2000.00',
      ...employeeOverrides,
    },
  });

  return { user, employee };
};

/** Client user + linked Client row. Returns both. */
export const makeClient = async (overrides = {}) => {
  const { user: userOverrides = {}, ...clientOverrides } = overrides;

  const user = await makeUser({
    role: 'client',
    firstName: 'Cara',
    lastName: 'Client',
    ...userOverrides,
  });

  const client = await prisma.client.create({
    data: {
      userId: user.id,
      clientUniqueNumber: uniq('CLT').toUpperCase(),
      companyName: 'Acme Logistics Ltd',
      contactName: 'Cara Client',
      email: user.email,
      fixedShipmentRate: '5.00',
      ...clientOverrides,
    },
  });

  return { user, client };
};

export const makeService = (overrides = {}) =>
  prisma.service.create({
    data: {
      description: 'Pick and pack',
      ideaPrice: '2.50',
      unit: 'item',
      ...overrides,
    },
  });

export const makeClientService = (clientId, serviceId, overrides = {}) =>
  prisma.clientService.create({
    data: {
      clientId,
      serviceId,
      chargedPrice: '3.00',
      unit: 'item',
      ...overrides,
    },
  });

export const makeLocationClass = (overrides = {}) =>
  prisma.warehouseLocationClass.create({
    data: { name: uniq('Shelf'), ...overrides },
  });

export const makeLocation = async (overrides = {}) => {
  const { locationClassId, ...rest } = overrides;
  const classId = locationClassId ?? (await makeLocationClass()).id;

  return prisma.warehouseLocation.create({
    data: {
      locationName: uniq('BIN').toUpperCase(),
      locationClassId: classId,
      ...rest,
    },
  });
};

export const makeProduct = (clientId, overrides = {}) =>
  prisma.product.create({
    data: {
      clientId,
      skuCode: uniq('SKU').toUpperCase(),
      productName: 'Blue Widget',
      thresholdLimit: 5,
      ...overrides,
    },
  });

export const makeStockLevel = (productId, locationId, overrides = {}) =>
  prisma.stockLevel.create({
    data: {
      productId,
      locationId,
      currentQuantity: 100,
      reservedQuantity: 0,
      ...overrides,
    },
  });

export const makeShipment = (employeeId, clientId, overrides = {}) =>
  prisma.shipment.create({
    data: {
      employeeId,
      clientId,
      shipmentType: 'Standard',
      packagingType: 'Box',
      courierName: 'Evri',
      status: 'PENDING',
      ...overrides,
    },
  });

export const makeShipmentItem = (
  shipmentId,
  productId,
  sourceLocationId,
  overrides = {}
) =>
  prisma.shipmentItem.create({
    data: {
      shipmentId,
      productId,
      sourceLocationId,
      quantity: 1,
      status: 'PENDING',
      ...overrides,
    },
  });

/** billingPeriod is normalised to the 1st of the month, as the app expects. */
export const makeInvoice = (clientId, overrides = {}) => {
  const now = new Date();
  return prisma.monthlyInvoice.create({
    data: {
      clientId,
      billingPeriod: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      totalAmount: '0.00',
      status: 'DRAFT',
      ...overrides,
    },
  });
};

export const makeShift = (overrides = {}) =>
  prisma.shift.create({
    data: {
      name: 'default',
      startTime: new Date('1970-01-01T08:00:00.000Z'),
      endTime: new Date('1970-01-01T17:00:00.000Z'),
      gracePeriodMins: 10,
      ...overrides,
    },
  });

/**
 * The cast most warehouse tests need: an admin, an employee, a client, one
 * product sitting in one bin with stock on hand.
 */
export const makeWarehouseScenario = async ({ quantity = 100 } = {}) => {
  const admin = await makeAdmin();
  const { user: employeeUser, employee } = await makeEmployee();
  const { user: clientUser, client } = await makeClient();

  const location = await makeLocation();
  const product = await makeProduct(client.id);
  const stock = await makeStockLevel(product.id, location.id, {
    currentQuantity: quantity,
  });

  return {
    admin,
    employeeUser,
    employee,
    clientUser,
    client,
    location,
    product,
    stock,
  };
};
