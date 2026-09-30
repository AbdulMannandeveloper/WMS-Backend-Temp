-- AlterTable
ALTER TABLE "invoice_line_items" ADD COLUMN     "fba_shipment_id" UUID;

-- AlterTable
ALTER TABLE "fba_shipment_items" ADD COLUMN     "returned_quantity" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "idx_line_items_fba_shipment_id" ON "invoice_line_items"("fba_shipment_id");

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_fba_shipment_id_fkey" FOREIGN KEY ("fba_shipment_id") REFERENCES "fba_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Link the charges already raised by dispatched bulk shipments, so deleting one
-- of those takes its charges off too. Dispatch has always described them as
-- "Bulk shipment <reference> — ...", on the shipment's own client's invoice.
-- Older single-consignment charges ("FBA consignment — ...") never named a
-- reference and stay unlinked.
UPDATE "invoice_line_items" AS l
SET "fba_shipment_id" = s."id"
FROM "fba_shipments" AS s, "monthly_invoices" AS inv
WHERE inv."id" = l."invoice_id"
  AND inv."client_id" = s."client_id"
  AND l."fba_shipment_id" IS NULL
  AND l."item_type" IN ('FBA_CHARGE', 'AUTOMATED_SERVICE')
  AND l."description" LIKE 'Bulk shipment ' || s."reference" || ' — %';
