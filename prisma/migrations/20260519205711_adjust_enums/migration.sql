/*
  Warnings:

  - The values [RECEIVING,PUTAWAY,PICKING,SHIPMENT,ADJUSTMENT] on the enum `InventoryMovementType` will be removed. If these variants are still used in the database, this will fail.
  - The values [BAY,STAGING,RECEIVING,SHIPPING] on the enum `LocationClass` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "InventoryMovementType_new" AS ENUM ('CHECKIN', 'INTERNAL_MOVE', 'CHECKOUT');
ALTER TABLE "inventory_ledger" ALTER COLUMN "movement_type" TYPE "InventoryMovementType_new" USING ("movement_type"::text::"InventoryMovementType_new");
ALTER TYPE "InventoryMovementType" RENAME TO "InventoryMovementType_old";
ALTER TYPE "InventoryMovementType_new" RENAME TO "InventoryMovementType";
DROP TYPE "public"."InventoryMovementType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "LocationClass_new" AS ENUM ('ZONE', 'AISLE', 'SHELF', 'BIN');
ALTER TABLE "warehouse_locations" ALTER COLUMN "location_class" TYPE "LocationClass_new" USING ("location_class"::text::"LocationClass_new");
ALTER TYPE "LocationClass" RENAME TO "LocationClass_old";
ALTER TYPE "LocationClass_new" RENAME TO "LocationClass";
DROP TYPE "public"."LocationClass_old";
COMMIT;
