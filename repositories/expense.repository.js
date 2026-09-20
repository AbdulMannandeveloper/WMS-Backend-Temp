const { prisma } = require('../lib/prisma');

const prismaExpense = prisma.expense;

const createExpense = async (data) => {
  return await prismaExpense.create({
    data,
    include: { category: true },
  });
};

/**
 * @param {object} where - a Prisma `where`; {} matches everything. Built by the
 *   logic layer, which is where the query-string filters are interpreted — this
 *   used to assemble the clause itself, which left the interpretation of
 *   startDate sitting below the layer that knows what a request meant.
 * @param {object} [options]
 * @param {object[]} [options.orderBy] - ends in a unique key, or pages repeat rows.
 * @param {object} [options.pagination] - { skip, take }. Absent, the whole set
 *   comes back as a bare array. finalizePayroll depends on that: it reads
 *   `.length` and `[0]` off the result to decide whether this month already has
 *   a salaries expense, and an envelope there would silently look empty.
 */
const getAllExpenses = async (where = {}, { orderBy, pagination } = {}) => {
  const sort = orderBy || [{ date: 'desc' }, { id: 'asc' }];

  if (pagination && pagination.take != null) {
    const [items, total] = await Promise.all([
      prismaExpense.findMany({
        where,
        include: { category: true },
        orderBy: sort,
        skip: pagination.skip || 0,
        take: pagination.take,
      }),
      prismaExpense.count({ where }),
    ]);
    return { items, total };
  }

  return await prismaExpense.findMany({
    where,
    include: { category: true },
    orderBy: sort,
  });
};

/**
 * Totals across the whole filtered set, not the page.
 *
 * The expenses screen shows a grand total and a card per category. Both were
 * computed in the browser from the full array, so paginating without this would
 * have quietly turned them into totals of whatever fifty rows were on screen.
 */
const summariseExpenses = async (where = {}) => {
  const [aggregate, byCategory] = await Promise.all([
    prismaExpense.aggregate({
      where,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prismaExpense.groupBy({
      by: ['categoryId'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  // groupBy cannot include a relation, so the names come separately — only for
  // the categories actually present in the result.
  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: byCategory.map((row) => row.categoryId) } },
    select: { id: true, categoryName: true },
  });
  const nameById = new Map(categories.map((c) => [c.id, c.categoryName]));

  return {
    total: aggregate._count._all,
    // Decimal, stringified rather than coerced: Number() on money is how a
    // total ends up a penny out, and the caller can format it.
    totalAmount: (aggregate._sum.amount ?? 0).toString(),
    byCategory: byCategory
      .map((row) => ({
        categoryId: row.categoryId,
        categoryName: nameById.get(row.categoryId) ?? null,
        count: row._count._all,
        total: (row._sum.amount ?? 0).toString(),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
  };
};

const getExpenseById = async (id) => {
  return await prismaExpense.findUnique({
    where: { id },
    include: { category: true },
  });
};

const updateExpense = async (id, data) => {
  return await prismaExpense.update({
    where: { id },
    data,
    include: { category: true },
  });
};

const deleteExpense = async (id) => {
  return await prismaExpense.delete({
    where: { id },
  });
};

module.exports = {
  createExpense,
  getAllExpenses,
  summariseExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
};
