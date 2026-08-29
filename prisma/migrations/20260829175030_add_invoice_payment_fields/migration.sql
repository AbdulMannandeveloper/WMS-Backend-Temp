-- AlterTable
ALTER TABLE "monthly_invoices" ADD COLUMN     "paid_at" TIMESTAMPTZ(6),
ADD COLUMN     "payment_method" VARCHAR(40),
ADD COLUMN     "payment_reference" VARCHAR(120);
