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

/**
 * The catalogue row for the dispatch charge, plus this client's agreed per-item
 * rate for it.
 *
 * Dispatch bills through the rate card now, not a column on Client. A client
 * without this simply is not charged for shipping — a real arrangement, so it
 * has to be opted into rather than assumed.
 */
export const makeShipmentRate = async (clientId, chargedPrice = '2.00') => {
  const service = await prisma.service.upsert({
    where: { code: 'SHIPMENT_DISPATCH' },
    update: {},
    create: {
      code: 'SHIPMENT_DISPATCH',
      description: 'Shipment dispatch (per item)',
      ideaPrice: '0.00',
      unit: 'item',
    },
  });

  const rate = await prisma.clientService.create({
    data: { clientId, serviceId: service.id, chargedPrice, unit: 'item' },
  });

  return { service, rate };
};

/** A standing monthly charge — storage, a retainer, anything not shipment-driven. */
export const makeRecurringService = async (clientId, overrides = {}) => {
  const service = await prisma.service.create({
    data: {
      description: overrides.description || uniq('Storage'),
      ideaPrice: '25.00',
      unit: 'month',
    },
  });

  const rate = await prisma.clientService.create({
    data: {
      clientId,
      serviceId: service.id,
      chargedPrice: overrides.chargedPrice || '25.00',
      unit: 'month',
      isRecurring: true,
      recurringQuantity: overrides.recurringQuantity || '1',
    },
  });

  return { service, rate };
};

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

// ─── Money & operations ───────────────────────────────────────────────────────
// Every @db.Date field below is built in UTC. Constructing one from local time
// stores the previous day east of UTC, which is how a month-boundary row ends up
// filed under the wrong month — the bug that made "August" return two rows.

/** A date-only value, safe to put in a @db.Date column from any timezone. */
export const utcDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

export const makeExpenseCategory = (overrides = {}) =>
  prisma.expenseCategory.create({
    data: { categoryName: uniq('Category'), ...overrides },
  });

export const makeExpense = async (categoryId, overrides = {}) => {
  const category = categoryId || (await makeExpenseCategory()).id;
  return prisma.expense.create({
    data: {
      categoryId: category,
      amount: '100.00',
      description: 'Test expense',
      date: utcDate(2026, 8, 15),
      ...overrides,
    },
  });
};

export const makeHoliday = (overrides = {}) =>
  prisma.holiday.create({
    data: {
      name: uniq('Holiday'),
      startDate: utcDate(2026, 12, 25),
      endDate: utcDate(2026, 12, 25),
      ...overrides,
    },
  });

export const makeAttendanceLog = (userId, overrides = {}) =>
  prisma.employeeAttendanceLog.create({
    data: {
      userId,
      status: 'on-time',
      date: utcDate(2026, 8, 3),
      loginTimestamp: new Date('2026-08-03T08:00:00.000Z'),
      logoutTimestamp: new Date('2026-08-03T17:00:00.000Z'),
      ...overrides,
    },
  });

export const makeAttendanceSummary = (userId, overrides = {}) =>
  prisma.monthlyAttendanceSummary.create({
    data: {
      userId,
      monthYear: utcDate(2026, 8, 1),
      totalDaysPresent: 20,
      totalHoursWorked: '160.00',
      ...overrides,
    },
  });

export const makePayrollRecord = (userId, overrides = {}) =>
  prisma.payrollRecord.create({
    data: {
      userId,
      baseSalary: '2000.00',
      fines: '0.00',
      rewards: '0.00',
      netPay: '2000.00',
      monthYear: utcDate(2026, 8, 1),
      ...overrides,
    },
  });

export const makeFineRule = (overrides = {}) =>
  prisma.fineRule.create({
    data: { lateMinutes: 15, fineType: 'FIXED', amount: '10.00', ...overrides },
  });

export const makeEmployeeFine = (userId, overrides = {}) =>
  prisma.employeeFine.create({
    data: {
      userId,
      reason: 'Late arrival',
      amount: '10.00',
      date: utcDate(2026, 8, 5),
      ...overrides,
    },
  });

export const makeEmployeeBonus = (userId, overrides = {}) =>
  prisma.employeeBonus.create({
    data: {
      userId,
      reason: 'Overtime',
      amount: '50.00',
      date: utcDate(2026, 8, 5),
      ...overrides,
    },
  });

// ─── Stock movement & billing detail ──────────────────────────────────────────

/**
 * A ledger row. movementType is the InventoryMovementType enum; from/to are
 * nullable because a check-in has no origin and a dispatch has no destination.
 */
export const makeLedgerEntry = (productId, userId, overrides = {}) =>
  prisma.inventoryLedger.create({
    data: {
      productId,
      userId,
      movementType: 'CHECKIN',
      quantity: 10,
      ...overrides,
    },
  });

export const makeInvoiceLineItem = (invoiceId, overrides = {}) =>
  prisma.invoiceLineItem.create({
    data: {
      invoiceId,
      itemType: 'MANUAL_CHARGE',
      dateOfService: utcDate(2026, 8, 10),
      description: 'Test line',
      quantity: '1.00',
      unitPrice: '10.00',
      totalPrice: '10.00',
      ...overrides,
    },
  });

export const makeShipmentServiceMapping = (shipmentId, serviceId, overrides = {}) =>
  prisma.shipmentServiceMapping.create({
    data: {
      shipmentId,
      serviceId,
      quantity: '1.00',
      appliedUnitPrice: '3.00',
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
