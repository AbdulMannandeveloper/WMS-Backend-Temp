const { prisma } = require('../lib/prisma');

const normalizeMonth = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

const getPLSummary = async (monthYearStr) => {
  const normalizedMonth = normalizeMonth(monthYearStr);
  const startOfMonth = normalizedMonth;
  const endOfMonth = new Date(normalizedMonth.getFullYear(), normalizedMonth.getMonth() + 1, 0, 23, 59, 59, 999);

  // 1. Calculate Total Earnings (Invoices with status APPROVED or PAID)
  const invoices = await prisma.monthlyInvoice.findMany({
    where: {
      billingPeriod: startOfMonth,
      status: { in: ['APPROVED', 'PAID'] },
    },
  });
  const totalEarnings = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount || 0), 0);

  // 2. Calculate Total Expenses (Salaries + Manual Expenses)
  const expenses = await prisma.expense.findMany({
    where: {
      date: {
        gte: startOfMonth,
        lte: endOfMonth,
      },
    },
  });
  const totalExpenses = expenses.reduce((acc, exp) => acc + Number(exp.amount || 0), 0);

  const netProfit = totalEarnings - totalExpenses;

  // Sync with ProfitLossLog table in DB
  try {
    await prisma.profitLossLog.upsert({
      where: { monthYear: startOfMonth },
      update: {
        totalEarnings,
        totalExpenses,
        netProfit,
      },
      create: {
        monthYear: startOfMonth,
        totalEarnings,
        totalExpenses,
        netProfit,
      },
    });
  } catch (err) {
    console.error('Failed to sync ProfitLossLog in database:', err.message);
  }

  return {
    monthYear: startOfMonth,
    totalEarnings,
    totalExpenses,
    netProfit,
  };
};

const getPLTrends = async (monthsCount = 6) => {
  const trends = [];
  const now = new Date();

  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const summary = await getPLSummary(d);

    // Format month label: "Apr 25" or "Jun 26"
    const monthLabel = d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });

    trends.push({
      month: monthLabel,
      monthDate: d.toISOString().slice(0, 10),
      revenue: summary.totalEarnings,
      expenses: summary.totalExpenses,
      profit: summary.netProfit,
    });
  }

  return trends;
};

const getClientProfitability = async (monthYearStr) => {
  const normalizedMonth = normalizeMonth(monthYearStr);

  // Get active clients
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      companyName: true,
    },
  });

  const list = [];
  for (const client of clients) {
    // Sum of client invoices for this billing period
    const invoices = await prisma.monthlyInvoice.findMany({
      where: {
        clientId: client.id,
        billingPeriod: normalizedMonth,
        status: { in: ['APPROVED', 'PAID'] },
      },
    });
    const revenue = invoices.reduce((acc, inv) => acc + Number(inv.totalAmount || 0), 0);

    list.push({
      clientId: client.id,
      companyName: client.companyName,
      revenue,
    });
  }

  // Sort by revenue descending
  return list.sort((a, b) => b.revenue - a.revenue);
};

module.exports = {
  getPLSummary,
  getPLTrends,
  getClientProfitability,
};
