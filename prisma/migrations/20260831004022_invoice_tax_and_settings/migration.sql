-- Tax on invoices, and a home for platform-wide settings.
--
-- total_amount stays EX-TAX. profit_loss.logic.js reads it as company
-- earnings, and VAT is collected on HMRC's behalf rather than earned, so
-- folding tax into it would overstate profit by the whole tax rate. The
-- client's grand total is total_amount + tax_amount, computed for display.
--
-- tax_rate is snapshotted onto the invoice when tax is applied, not read live
-- at render time: an invoice already sent to a client must not silently
-- change because the platform rate moved afterwards. Same reasoning as the
-- frozen unit prices on every line item.
--
-- settings is key/value rather than an environment variable so the rate can
-- change without a redeploy, and carries who changed it and when.

-- AlterTable
ALTER TABLE "monthly_invoices" ADD COLUMN     "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0.0,
ADD COLUMN     "tax_applied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tax_rate" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" VARCHAR(255) NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

