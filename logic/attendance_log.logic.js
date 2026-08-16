const attendanceLogRepository = require("../repositories/attendance_log.repository");
const shiftRepository = require("../repositories/shift.repository");
const holidayRepository = require("../repositories/holiday.repository");
const { prisma } = require("../lib/prisma");

/** Normalize any date-like value to a UTC calendar day (YYYY-MM-DD @ 00:00 UTC). */
const toUtcDateOnly = (value) => {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const dateKey = (value) => toUtcDateOnly(value).toISOString().slice(0, 10);

/**
 * Count calendar days in [rangeStart, rangeEnd] that fall inside any holiday range.
 * Inclusive on both ends; holidays may span multiple days.
 */
const countHolidayDaysInRange = (holidays, rangeStart, rangeEnd) => {
  const start = toUtcDateOnly(rangeStart);
  const end = toUtcDateOnly(rangeEnd);
  const keys = new Set();

  for (const holiday of holidays) {
    let cursor = toUtcDateOnly(holiday.startDate);
    const holidayEnd = toUtcDateOnly(holiday.endDate);
    while (cursor <= holidayEnd) {
      if (cursor >= start && cursor <= end) {
        keys.add(cursor.toISOString().slice(0, 10));
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  return keys.size;
};

const isDateHoliday = async (dateValue) => {
  const day = toUtcDateOnly(dateValue);
  const holidays = await holidayRepository.getAllHolidays();
  return holidays.some((holiday) => {
    const start = toUtcDateOnly(holiday.startDate);
    const end = toUtcDateOnly(holiday.endDate);
    return day >= start && day <= end;
  });
};

const createAttendanceLog = async (logData) => {
  if (!logData.userId || !logData.loginTimestamp) {
    throw new Error("Missing required fields: userId, loginTimestamp");
  }

  // ----------------------------------------- DEFAULT SHIFT ASSIGNMENT LOGIC -----------------------------------------
  const shift = await shiftRepository.getShiftFirstByField("name", "default");
  if (!shift) {
    throw new Error("Shift not found. Please select an existing shift first.");
  }

  // Check if the login timestamp is within the shift's grace period and enter relevant status
  const loginDate = new Date(logData.loginTimestamp);
  const loginMinutes = loginDate.getUTCHours() * 60 + loginDate.getUTCMinutes();

  const shiftStart = new Date(shift.startTime);
  const shiftMinutes = shiftStart.getUTCHours() * 60 + shiftStart.getUTCMinutes();

  if (loginMinutes <= shiftMinutes + shift.gracePeriodMins) {
    logData.status = "on-time";
  } else {
    logData.status = "late";
  }

  // Ensure date is set from the login day when callers omit it
  if (!logData.date) {
    logData.date = toUtcDateOnly(logData.loginTimestamp);
  }

  const createdLog = await attendanceLogRepository.createAttendanceLog(logData);

  // Working on a holiday is allowed, but late fines are skipped that day.
  const holidayDay = await isDateHoliday(logData.date || logData.loginTimestamp);

  if (logData.status === "late" && !holidayDay) {
    try {
      const fineRule = await prisma.fineRule.findFirst({
        orderBy: { createdAt: "desc" },
      });
      if (fineRule) {
        let fineAmount = Number(fineRule.amount);
        if (fineRule.fineType === "PERCENTAGE") {
          const employee = await prisma.employee.findUnique({
            where: { userId: logData.userId },
          });
          const base = employee?.baseSalary ? Number(employee.baseSalary) : 0;
          fineAmount = (base * Number(fineRule.amount)) / 100;
        }

        if (fineAmount > 0) {
          await prisma.employeeFine.create({
            data: {
              userId: logData.userId,
              reason: `Late check-in — ${new Date(logData.loginTimestamp).toLocaleDateString("en-GB")}`,
              amount: fineAmount,
              date: new Date(logData.loginTimestamp),
              cancelled: false,
            },
          });
          console.log(`[Fine] Automatically applied late arrival fine of £${fineAmount} to user ${logData.userId}`);
        }
      }
    } catch (err) {
      console.error("Failed to automatically apply late check-in fine:", err.message);
    }
  }

  return createdLog;
};

/**
 * Admin-marked leave for a calendar day (no clock-in).
 * Overwrites an existing worked day when forceOverwrite is true (UI confirms).
 */
const markLeave = async ({ userId, date, forceOverwrite = false }) => {
  if (!userId || !date) {
    throw new Error("Missing required fields: userId, date");
  }

  const day = toUtcDateOnly(date);

  if (await isDateHoliday(day)) {
    throw new Error("Cannot mark leave on a holiday. The day is already a holiday.");
  }

  const existing = await prisma.employeeAttendanceLog.findUnique({
    where: { userId_date: { userId, date: day } },
  });

  if (existing) {
    if (existing.status === "leave") {
      return existing;
    }
    if (!forceOverwrite) {
      throw new Error(
        "An attendance record already exists for this day. Confirm overwrite to mark as leave.",
      );
    }
    return await attendanceLogRepository.updateAttendanceLog(existing.id, {
      status: "leave",
      loginTimestamp: null,
      logoutTimestamp: null,
    });
  }

  return await attendanceLogRepository.createAttendanceLog({
    userId,
    date: day,
    status: "leave",
    loginTimestamp: null,
    logoutTimestamp: null,
  });
};

/** Remove a leave mark for a day (deletes the leave row). */
const unmarkLeave = async ({ userId, date }) => {
  if (!userId || !date) {
    throw new Error("Missing required fields: userId, date");
  }

  const day = toUtcDateOnly(date);
  const existing = await prisma.employeeAttendanceLog.findUnique({
    where: { userId_date: { userId, date: day } },
  });

  if (!existing) {
    throw new Error("No attendance record found for this day.");
  }
  if (existing.status !== "leave") {
    throw new Error("This day is not marked as leave.");
  }

  return await attendanceLogRepository.deleteAttendanceLog(existing.id);
};

const getAllAttendanceLogs = async (pagination) => {
  return await attendanceLogRepository.getAllAttendanceLogs(pagination);
};

const getAttendanceLogByUserId = async (id) => {
  return await attendanceLogRepository.getAttendanceLogByField("userId", id);
};

const getAttendanceLogByField = async (field, value) => {
  return await attendanceLogRepository.getAttendanceLogByField(field, value);
};

const updateAttendanceLog = async (id, updateData) => {
  if (updateData.status === "leave") {
    updateData.loginTimestamp = null;
    updateData.logoutTimestamp = null;
  }
  return await attendanceLogRepository.updateAttendanceLog(id, updateData);
};

const updateLogoutTimestamp = async (id, logoutTimestamp) => {
  const attendanceLog = await attendanceLogRepository.getAttendanceLogFirstByField(
    "id",
    id,
  );
  if (!attendanceLog) {
    throw new Error("Attendance log not found");
  }
  if (attendanceLog.status === "leave") {
    throw new Error("Cannot clock out of a leave day");
  }
  if (!attendanceLog.loginTimestamp) {
    throw new Error("Cannot set logout without a login timestamp");
  }
  if (new Date(logoutTimestamp) < new Date(attendanceLog.loginTimestamp)) {
    throw new Error("Logout timestamp cannot be before login timestamp");
  }

  return await attendanceLogRepository.updateAttendanceLog(id, {
    logoutTimestamp,
  });
};

const deleteAttendanceLog = async (id) => {
  return await attendanceLogRepository.deleteAttendanceLog(id);
};

// US-069: Compute and persist a MonthlyAttendanceSummary for a given user + month
// monthYear should be a Date normalised to the 1st of the month (e.g. 2026-04-01)
const archiveMonthlyAttendanceSummary = async (userId, monthYear) => {
  const startOfMonth = new Date(Date.UTC(monthYear.getUTCFullYear(), monthYear.getUTCMonth(), 1));
  const endOfMonth = new Date(Date.UTC(monthYear.getUTCFullYear(), monthYear.getUTCMonth() + 1, 0));

  const logs = await prisma.employeeAttendanceLog.findMany({
    where: {
      userId,
      date: { gte: startOfMonth, lte: endOfMonth },
    },
  });

  const onTimeLogs = logs.filter((log) => log.status === "on-time");
  const lateLogs = logs.filter((log) => log.status === "late");
  const leaveLogs = logs.filter((log) => log.status === "leave");

  const totalOnTimeDays = onTimeLogs.length;
  const totalLateArrivals = lateLogs.length;
  const totalLeaveDays = leaveLogs.length;
  const totalDaysPresent = totalOnTimeDays + totalLateArrivals;

  let totalHoursWorked = 0;
  for (const log of [...onTimeLogs, ...lateLogs]) {
    if (log.loginTimestamp && log.logoutTimestamp) {
      const diffMs = new Date(log.logoutTimestamp) - new Date(log.loginTimestamp);
      totalHoursWorked += diffMs / (1000 * 60 * 60);
    }
  }

  const holidays = await holidayRepository.getAllHolidays();
  const totalHolidayDays = countHolidayDaysInRange(holidays, startOfMonth, endOfMonth);

  const summaryPayload = {
    totalDaysPresent,
    totalOnTimeDays,
    totalLateArrivals,
    totalLeaveDays,
    totalHolidayDays,
    totalHoursWorked: Number(totalHoursWorked.toFixed(2)),
  };

  const summary = await prisma.monthlyAttendanceSummary.upsert({
    where: {
      userId_monthYear: { userId, monthYear: startOfMonth },
    },
    update: summaryPayload,
    create: {
      userId,
      monthYear: startOfMonth,
      ...summaryPayload,
    },
  });

  return summary;
};

// US-068/069: Archive summaries for all employees for months older than 2 months, then purge daily logs
const archiveAndCleanupOldLogs = async () => {
  const now = new Date();
  const twoMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));

  const oldLogs = await prisma.employeeAttendanceLog.findMany({
    where: { date: { lt: twoMonthsAgo } },
    select: { userId: true, date: true },
    distinct: ["userId"],
  });

  const processed = [];

  for (const { userId } of oldLogs) {
    const userOldLogs = await prisma.employeeAttendanceLog.findMany({
      where: { userId, date: { lt: twoMonthsAgo } },
      select: { date: true },
    });

    const uniqueMonths = [
      ...new Set(
        userOldLogs.map((l) => {
          const d = new Date(l.date);
          return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        }),
      ),
    ];

    for (const monthKey of uniqueMonths) {
      const [year, month] = monthKey.split("-").map(Number);
      const monthDate = new Date(Date.UTC(year, month, 1));

      await archiveMonthlyAttendanceSummary(userId, monthDate);

      const monthEnd = new Date(Date.UTC(year, month + 1, 0));
      await prisma.employeeAttendanceLog.deleteMany({
        where: {
          userId,
          date: { gte: monthDate, lte: monthEnd },
        },
      });

      processed.push({ userId, month: monthDate.toISOString().slice(0, 7) });
    }
  }

  return {
    message: `Archived and cleaned up logs for ${processed.length} user-month pair(s).`,
    processed,
  };
};

const emptyMonthStats = () => ({
  totalDaysPresent: 0,
  totalOnTimeDays: 0,
  totalLateArrivals: 0,
  totalLeaveDays: 0,
  totalHolidayDays: 0,
  totalHoursWorked: 0,
});

const summarizeLogsForMonth = (logs, holidays, startOfMonth, endOfMonth) => {
  const onTimeLogs = logs.filter((log) => log.status === "on-time");
  const lateLogs = logs.filter((log) => log.status === "late");
  const leaveLogs = logs.filter((log) => log.status === "leave");

  let totalHoursWorked = 0;
  for (const log of [...onTimeLogs, ...lateLogs]) {
    if (log.loginTimestamp && log.logoutTimestamp) {
      const diffMs = new Date(log.logoutTimestamp) - new Date(log.loginTimestamp);
      totalHoursWorked += diffMs / (1000 * 60 * 60);
    }
  }

  return {
    totalDaysPresent: onTimeLogs.length + lateLogs.length,
    totalOnTimeDays: onTimeLogs.length,
    totalLateArrivals: lateLogs.length,
    totalLeaveDays: leaveLogs.length,
    totalHolidayDays: countHolidayDaysInRange(holidays, startOfMonth, endOfMonth),
    totalHoursWorked: Number(totalHoursWorked.toFixed(2)),
  };
};

const monthKeyFromDate = (dateValue) => {
  const d = new Date(dateValue);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

/**
 * Employee attendance analytics: merges archived MonthlyAttendanceSummary rows
 * with live daily logs for recent months (not yet archived).
 * Optional year / month query filters the period view; allTime is always full history.
 */
const getEmployeeAttendanceAnalytics = async (userId, { year, month } = {}) => {
  if (!userId) {
    throw new Error("userId is required");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true, email: true, role: true },
  });
  if (!user) {
    throw new Error("User not found");
  }

  const [summaries, logs, holidays] = await Promise.all([
    prisma.monthlyAttendanceSummary.findMany({
      where: { userId },
      orderBy: { monthYear: "asc" },
    }),
    prisma.employeeAttendanceLog.findMany({
      where: { userId },
      orderBy: { date: "asc" },
    }),
    holidayRepository.getAllHolidays(),
  ]);

  const byMonth = new Map();

  for (const summary of summaries) {
    const key = monthKeyFromDate(summary.monthYear);
    byMonth.set(key, {
      month: key,
      source: "archive",
      totalDaysPresent: summary.totalDaysPresent,
      totalOnTimeDays: summary.totalOnTimeDays ?? 0,
      totalLateArrivals: summary.totalLateArrivals,
      totalLeaveDays: summary.totalLeaveDays ?? 0,
      totalHolidayDays: summary.totalHolidayDays ?? 0,
      totalHoursWorked: Number(summary.totalHoursWorked),
    });
  }

  // Live logs override / fill months that still have daily detail
  const logsByMonth = new Map();
  for (const log of logs) {
    const key = monthKeyFromDate(log.date);
    if (!logsByMonth.has(key)) logsByMonth.set(key, []);
    logsByMonth.get(key).push(log);
  }

  for (const [key, monthLogs] of logsByMonth.entries()) {
    const [y, m] = key.split("-").map(Number);
    const startOfMonth = new Date(Date.UTC(y, m - 1, 1));
    const endOfMonth = new Date(Date.UTC(y, m, 0));
    byMonth.set(key, {
      month: key,
      source: "live",
      ...summarizeLogsForMonth(monthLogs, holidays, startOfMonth, endOfMonth),
    });
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  const sumMonths = (rows) =>
    rows.reduce(
      (acc, row) => {
        acc.totalDaysPresent += row.totalDaysPresent || 0;
        acc.totalOnTimeDays += row.totalOnTimeDays || 0;
        acc.totalLateArrivals += row.totalLateArrivals || 0;
        acc.totalLeaveDays += row.totalLeaveDays || 0;
        acc.totalHolidayDays += row.totalHolidayDays || 0;
        acc.totalHoursWorked += Number(row.totalHoursWorked) || 0;
        return acc;
      },
      emptyMonthStats(),
    );

  const allTimeRaw = sumMonths(months);
  const allTime = {
    ...allTimeRaw,
    totalHoursWorked: Number(allTimeRaw.totalHoursWorked.toFixed(2)),
    monthsCovered: months.length,
  };

  let filtered = months;
  if (year) {
    const y = String(year);
    filtered = filtered.filter((row) => row.month.startsWith(`${y}-`));
  }
  if (month) {
    const m = String(month).padStart(2, "0");
    filtered = filtered.filter((row) => row.month.endsWith(`-${m}`));
  }

  const periodRaw = sumMonths(filtered);
  const period = {
    ...periodRaw,
    totalHoursWorked: Number(periodRaw.totalHoursWorked.toFixed(2)),
    monthsCovered: filtered.length,
  };

  // Daily logs only when a single month is selected and live data still exists
  let dailyLogs = [];
  if (year && month) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    dailyLogs = (logsByMonth.get(key) || []).map((log) => ({
      id: log.id,
      date: log.date,
      status: log.status,
      loginTimestamp: log.loginTimestamp,
      logoutTimestamp: log.logoutTimestamp,
    }));
  }

  return {
    user,
    filters: {
      year: year ? Number(year) : null,
      month: month ? Number(month) : null,
    },
    allTime,
    period,
    months: filtered,
    history: months,
    dailyLogs,
  };
};

module.exports = {
  createAttendanceLog,
  markLeave,
  unmarkLeave,
  getAllAttendanceLogs,
  getAttendanceLogByUserId,
  getAttendanceLogByField,
  updateLogoutTimestamp,
  updateAttendanceLog,
  deleteAttendanceLog,
  archiveMonthlyAttendanceSummary,
  archiveAndCleanupOldLogs,
  getEmployeeAttendanceAnalytics,
  isDateHoliday,
  countHolidayDaysInRange,
  toUtcDateOnly,
  dateKey,
};
