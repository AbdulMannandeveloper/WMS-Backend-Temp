-- Promote shipment / shipment item status from free text to enums, and add the
-- courier tracking columns.
--
-- Prisma's generated version dropped and recreated the status columns, which
-- resets every row to PENDING. This converts in place with a USING cast instead,
-- so the migration is safe to run against an environment that already has
-- shipments. Unrecognised values fall back to PENDING rather than being assumed
-- dispatched — the old column was unvalidated free text and could hold anything.

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentItemStatus" AS ENUM ('PENDING', 'PICKED');

-- AlterTable: shipments
ALTER TABLE "shipments" ADD COLUMN "tracking_id" VARCHAR(64);

ALTER TABLE "shipments" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "shipments" ALTER COLUMN "status" TYPE "ShipmentStatus" USING (
  CASE upper(trim("status"))
    WHEN 'READY_FOR_DISPATCH' THEN 'READY_FOR_DISPATCH'
    WHEN 'DISPATCHED'         THEN 'DISPATCHED'
    WHEN 'CANCELLED'          THEN 'CANCELLED'
    WHEN 'CANCELED'           THEN 'CANCELLED'
    ELSE 'PENDING'
  END
)::"ShipmentStatus";
ALTER TABLE "shipments" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable: shipment_items
-- READY and PACKED both appeared in earlier code and comments for a line that
-- had been taken off the shelf; both collapse to PICKED.
ALTER TABLE "shipment_items" ADD COLUMN "tracking_id" VARCHAR(64);

ALTER TABLE "shipment_items" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "shipment_items" ALTER COLUMN "status" TYPE "ShipmentItemStatus" USING (
  CASE upper(trim("status"))
    WHEN 'PICKED' THEN 'PICKED'
    WHEN 'READY'  THEN 'PICKED'
    WHEN 'PACKED' THEN 'PICKED'
    ELSE 'PENDING'
  END
)::"ShipmentItemStatus";
ALTER TABLE "shipment_items" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "idx_shipment_items_shipment_id" ON "shipment_items"("shipment_id");

-- CreateIndex
CREATE INDEX "idx_shipment_items_tracking_id" ON "shipment_items"("tracking_id");

-- CreateIndex
CREATE INDEX "idx_shipments_tracking_id" ON "shipments"("tracking_id");
