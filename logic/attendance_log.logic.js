const attendanceLogRepository = require("../repositories/attendance_log.repository");
const shiftRepository = require("../repositories/shift.repository");
const holidayRepository = require("../repositories/holiday.repository");
const { prisma } = require("../lib/prisma");

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

  const createdLog = await attendanceLogRepository.createAttendanceLog(logData);

  if (logData.status === "late") {
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
              reason: `Late check-in — ${new Date(logData.loginTimestamp).toLocaleDateString('en-GB')}`,
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

const getAllAttendanceLogs = async () => {
  return await attendanceLogRepository.getAllAttendanceLogs();
};

const getAttendanceLogByUserId = async (id) => {
  return await attendanceLogRepository.getAttendanceLogByField("userId", id);
};

const getAttendanceLogByField = async (field, value) => {
  return await attendanceLogRepository.getAttendanceLogByField(field, value);
};

const updateAttendanceLog = async (id, updateData) => {
  return await attendanceLogRepository.updateAttendanceLog(id, updateData);
};

const updateLogoutTimestamp = async (id, logoutTimestamp) => {
  const attendanceLog = await attendanceLogRepository.getAttendanceLogFirstByField(
    "id",
    id,
  );
  if (!attendanceLog) {
    throw new Error("Attendance log not found");
  } else {
    // Check if the logout timestamp is before the login timestamp
    if (new Date(logoutTimestamp) < new Date(attendanceLog.loginTimestamp)) {
      throw new Error("Logout timestamp cannot be before login timestamp");
    }
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
  const startOfMonth = new Date(monthYear.getFullYear(), monthYear.getMonth(), 1);
  const endOfMonth = new Date(monthYear.getFullYear(), monthYear.getMonth() + 1, 0, 23, 59, 59, 999);

  // Fetch all daily logs for this user in this month
  const logs = await prisma.employeeAttendanceLog.findMany({
    where: {
      userId,
      date: { gte: startOfMonth, lte: endOfMonth },
    },
  });

  const totalDaysPresent = logs.length;
  const totalLateArrivals = logs.filter((log) => log.status === "late").length;

  // Compute total hours worked from login → logout pairs
  let totalHoursWorked = 0;
  for (const log of logs) {
    if (log.loginTimestamp && log.logoutTimestamp) {
      const diffMs = new Date(log.logoutTimestamp) - new Date(log.loginTimestamp);
      totalHoursWorked += diffMs / (1000 * 60 * 60); // convert ms to hours
    }
  }

  // Upsert the MonthlyAttendanceSummary (create or update if already exists)
  const summary = await prisma.monthlyAttendanceSummary.upsert({
    where: {
      userId_monthYear: { userId, monthYear: startOfMonth },
    },
    update: {
      totalDaysPresent,
      totalLateArrivals,
      totalHoursWorked: Number(totalHoursWorked.toFixed(2)),
    },
    create: {
      userId,
      monthYear: startOfMonth,
      totalDaysPresent,
      totalLateArrivals,
      totalHoursWorked: Number(totalHoursWorked.toFixed(2)),
    },
  });

  return summary;
};

// US-068/069: Archive summaries for all employees for months older than 2 months, then purge daily logs
const archiveAndCleanupOldLogs = async () => {
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
  twoMonthsAgo.setDate(1);
  twoMonthsAgo.setHours(0, 0, 0, 0);

  // Find all distinct userId + month combinations that are older than 2 months
  const oldLogs = await prisma.employeeAttendanceLog.findMany({
    where: { date: { lt: twoMonthsAgo } },
    select: { userId: true, date: true },
    distinct: ["userId"],
  });

  const processed = [];

  for (const { userId, date } of oldLogs) {
    // Find all unique months for this user before the cutoff
    const userOldLogs = await prisma.employeeAttendanceLog.findMany({
      where: { userId, date: { lt: twoMonthsAgo } },
      select: { date: true },
    });

    const uniqueMonths = [
      ...new Set(
        userOldLogs.map((l) => {
          const d = new Date(l.date);
          return `${d.getFullYear()}-${d.getMonth()}`;
        })
      ),
    ];

    for (const monthKey of uniqueMonths) {
      const [year, month] = monthKey.split("-").map(Number);
      const monthDate = new Date(year, month, 1);

      // Archive the summary for this user + month
      await archiveMonthlyAttendanceSummary(userId, monthDate);

      // Delete the detailed daily logs for this user + month
      const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
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

module.exports = {
  createAttendanceLog,
  getAllAttendanceLogs,
  getAttendanceLogByUserId,
  getAttendanceLogByField,
  updateLogoutTimestamp,
  updateAttendanceLog,
  deleteAttendanceLog,
  archiveMonthlyAttendanceSummary,
  archiveAndCleanupOldLogs,
};
