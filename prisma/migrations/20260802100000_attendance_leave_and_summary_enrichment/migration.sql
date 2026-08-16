-- AlterTable: allow leave rows without a clock-in timestamp
ALTER TABLE "employee_attendance_logs" ALTER COLUMN "login_timestamp" DROP NOT NULL;

-- AlterTable: enrich monthly attendance summaries
ALTER TABLE "monthly_attendance_summary" ADD COLUMN "total_on_time_days" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "monthly_attendance_summary" ADD COLUMN "total_leave_days" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "monthly_attendance_summary" ADD COLUMN "total_holiday_days" INTEGER NOT NULL DEFAULT 0;
