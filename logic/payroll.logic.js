const { prisma } = require('../lib/prisma');
const employeeRepository = require('../repositories/employee.repository');
const fineRuleRepository = require('../repositories/fine_rule.repository');
const employeeFineRepository = require('../repositories/employee_fine.repository');
const employeeBonusRepository = require('../repositories/employee_bonus.repository');
const payrollRepository = require('../repositories/payroll.repository');
const expenseCategoryRepository = require('../repositories/expense_category.repository');
const expenseRepository = require('../repositories/expense.repository');
const auditLogLogic = require('./audit_log.logic');
const { firstOfMonthUtc, endOfMonthUtc, lastDayOfMonthUtc } = require('../utils/dates');

// month_year is a @db.Date, so the boundary must be built in UTC — see utils/dates.js.
const normalizeMonth = (dateInput) => firstOfMonthUtc(dateInput);

const setBaseSalary = async (employeeId, amount, adminUserId) => {
  if (amount === undefined || amount === null || amount < 0) {
    throw new Error('Valid base salary amount is required.');
  }

  const employee = await employeeRepository.getEmployeeByField('id', employeeId);
  if (!employee) {
    throw new Error('Employee not found.');
  }

  const updated = await employeeRepository.updateEmployee(employeeId, {
    baseSalary: Number(amount),
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'SET_BASE_SALARY', {
      employeeId,
      employeeName: `${employee.user.firstName} ${employee.user.lastName}`,
      baseSalary: Number(amount),
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return updated;
};

const createFineRule = async (data, adminUserId) => {
  if (!data.fineType || !['FIXED', 'PERCENTAGE'].includes(data.fineType)) {
    throw new Error('Fine type must be FIXED or PERCENTAGE.');
  }
  if (data.amount === undefined || data.amount === null || data.amount <= 0) {
    throw new Error('Valid fine amount is required.');
  }

  const rule = await fineRuleRepository.createFineRule({
    lateMinutes: Number(data.lateMinutes || 0),
    fineType: data.fineType,
    amount: Number(data.amount),
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'CREATE_FINE_RULE', {
      ruleId: rule.id,
      fineType: rule.fineType,
      amount: Number(rule.amount),
      lateMinutes: rule.lateMinutes,
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return rule;
};

const getActiveFineRule = async () => {
  return await fineRuleRepository.getActiveFineRule();
};

const createFine = async (data, adminUserId) => {
  if (!data.userId || !data.amount || !data.reason) {
    throw new Error('User ID, amount, and reason are required to create a fine.');
  }

  const user = await prisma.user.findUnique({ where: { id: data.userId } });
  if (!user) {
    throw new Error('User not found.');
  }

  const fine = await employeeFineRepository.createFine({
    userId: data.userId,
    amount: Number(data.amount),
    reason: data.reason,
    date: data.date ? new Date(data.date) : new Date(),
    cancelled: false,
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'ADD_FINE', {
      fineId: fine.id,
      employeeName: `${user.firstName} ${user.lastName}`,
      amount: Number(fine.amount),
      reason: fine.reason,
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return fine;
};

const toggleCancelFine = async (fineId, adminUserId) => {
  const fine = await employeeFineRepository.getFineById(fineId);
  if (!fine) {
    throw new Error('Fine record not found.');
  }

  const updated = await employeeFineRepository.updateFine(fineId, {
    cancelled: !fine.cancelled,
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'TOGGLE_CANCEL_FINE', {
      fineId,
      cancelled: updated.cancelled,
      reason: updated.reason,
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return updated;
};

const createBonus = async (data, adminUserId) => {
  if (!data.userId || !data.amount || !data.reason) {
    throw new Error('User ID, amount, and reason are required to create a bonus.');
  }

  const user = await prisma.user.findUnique({ where: { id: data.userId } });
  if (!user) {
    throw new Error('User not found.');
  }

  const bonus = await employeeBonusRepository.createBonus({
    userId: data.userId,
    amount: Number(data.amount),
    reason: data.reason,
    date: data.date ? new Date(data.date) : new Date(),
  });

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'ADD_BONUS', {
      bonusId: bonus.id,
      employeeName: `${user.firstName} ${user.lastName}`,
      amount: Number(bonus.amount),
      reason: bonus.reason,
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return bonus;
};

const getSalaryBreakdownForEmployee = async (userId, monthDate) => {
  const normalizedMonth = normalizeMonth(monthDate);
  const startOfMonth = normalizedMonth;
  const endOfMonth = endOfMonthUtc(normalizedMonth);

  // Fetch employee record to get fixed baseSalary
  const employee = await prisma.employee.findUnique({
    where: { userId },
    include: { user: true },
  });

  if (!employee) {
    throw new Error('Employee record not found for user.');
  }

  // Fetch monthly attendance summary for that month
  const attendanceSummary = await prisma.monthlyAttendanceSummary.findFirst({
    where: {
      userId,
      monthYear: startOfMonth,
    },
  });

  // Fetch detailed attendance logs for checking real-time counts
  const lateLogsCount = await prisma.employeeAttendanceLog.count({
    where: {
      userId,
      status: 'late',
      date: {
        gte: startOfMonth,
        lte: endOfMonth,
      },
    },
  });

  // Fetch fines and bonuses
  const fines = await employeeFineRepository.getFinesByUserAndMonth(userId, startOfMonth, endOfMonth);
  const bonuses = await employeeBonusRepository.getBonusesByUserAndMonth(userId, startOfMonth, endOfMonth);

  const baseSalary = employee.baseSalary ? Number(employee.baseSalary) : 0;
  const totalFines = fines.filter((f) => !f.cancelled).reduce((acc, f) => acc + Number(f.amount), 0);
  const totalBonuses = bonuses.reduce((acc, b) => acc + Number(b.amount), 0);
  const netPay = baseSalary - totalFines + totalBonuses;

  return {
    userId,
    employeeId: employee.id,
    employeeName: `${employee.user.firstName} ${employee.user.lastName}`,
    employeeUniqueNumber: employee.employeeUniqueNumber,
    jobTitle: employee.jobTitle,
    baseSalary,
    fines,
    bonuses,
    totalFines,
    totalBonuses,
    netPay,
    lateArrivalsCount: lateLogsCount,
    daysPresent: attendanceSummary?.totalDaysPresent || 0,
    hoursWorked: attendanceSummary?.totalHoursWorked ? Number(attendanceSummary.totalHoursWorked) : 0,
    monthYear: startOfMonth,
  };
};

const getSalarySummaryForAll = async (monthYearStr) => {
  const normalizedMonth = normalizeMonth(monthYearStr);

  // Fetch all active employees
  const employees = await prisma.employee.findMany({
    where: { user: { isActive: true } },
    select: { userId: true },
  });

  const summary = [];
  for (const emp of employees) {
    try {
      const breakdown = await getSalaryBreakdownForEmployee(emp.userId, normalizedMonth);
      summary.push(breakdown);
    } catch {
      // skip if error
    }
  }

  return summary;
};

const finalizePayroll = async (monthYearStr, adminUserId) => {
  const normalizedMonth = normalizeMonth(monthYearStr);
  const monthLabel = normalizedMonth.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  // Get breakdown for all employees
  const summary = await getSalarySummaryForAll(normalizedMonth);
  if (summary.length === 0) {
    throw new Error('No employee salary data to finalize.');
  }

  let totalNetSalaries = 0;

  // Persist PayrollRecord for each employee
  for (const record of summary) {
    totalNetSalaries += record.netPay;

    await payrollRepository.upsertPayrollRecord(record.userId, normalizedMonth, {
      baseSalary: record.baseSalary,
      fines: record.totalFines,
      rewards: record.totalBonuses,
      netPay: record.netPay,
    });
  }

  // Ensure "Salaries" Category exists in ExpenseCategory
  let salariesCategory = await expenseCategoryRepository.getCategoryByName('Salaries');
  if (!salariesCategory) {
    salariesCategory = await expenseCategoryRepository.createCategory({
      categoryName: 'Salaries',
      isSystemGenerated: true,
    });
  }

  // Check if Expense already exists for "Salaries" for this month
  const existingExpenses = await expenseRepository.getAllExpenses({
    categoryId: salariesCategory.id,
    startDate: normalizedMonth,
    endDate: lastDayOfMonthUtc(normalizedMonth),
  });

  let expense;
  if (existingExpenses.length > 0) {
    expense = await expenseRepository.updateExpense(existingExpenses[0].id, {
      amount: totalNetSalaries,
      description: `Finalized payroll for ${monthLabel} (${summary.length} employees)`,
      date: normalizedMonth,
    });
  } else {
    expense = await expenseRepository.createExpense({
      categoryId: salariesCategory.id,
      amount: totalNetSalaries,
      description: `Finalized payroll for ${monthLabel} (${summary.length} employees)`,
      date: normalizedMonth,
    });
  }

  if (adminUserId) {
    await auditLogLogic.createAuditLog(adminUserId, 'FINALIZE_PAYROLL', {
      month: monthLabel,
      totalEmployees: summary.length,
      totalSalaries: totalNetSalaries,
      expenseId: expense.id,
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return {
    message: `Payroll finalized successfully for ${monthLabel}.`,
    employeesCount: summary.length,
    totalSalaries: totalNetSalaries,
    expense,
  };
};

module.exports = {
  setBaseSalary,
  createFineRule,
  getActiveFineRule,
  createFine,
  toggleCancelFine,
  createBonus,
  getSalaryBreakdownForEmployee,
  getSalarySummaryForAll,
  finalizePayroll,
};
