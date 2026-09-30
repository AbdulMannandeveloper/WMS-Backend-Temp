-- AlterTable
ALTER TABLE "fba_shipment_items" ADD COLUMN     "picked_quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "put_back_quantity" INTEGER NOT NULL DEFAULT 0;

-- Lines on in-flight and dispatched shipments were scanned in on the floor under
-- the old flow, so they count as picked; without this every PREPARING shipment
-- would be blocked from dispatch until re-scanned. Voided ones are left at zero:
-- their reservation was handed back when they were voided, and a picked count
-- there would block them for good.
UPDATE "fba_shipment_items" AS i
SET "picked_quantity" = i."quantity"
FROM "fba_shipments" AS s
WHERE s."id" = i."fba_shipment_id"
  AND s."status" IN ('PREPARING', 'DISPATCHED');
