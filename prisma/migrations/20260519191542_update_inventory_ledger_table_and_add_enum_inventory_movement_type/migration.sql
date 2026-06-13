/*
  Warnings:

  - The primary key for the `clients_services` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `location_id` on the `inventory_ledger` table. All the data in the column will be lost.
  - You are about to drop the column `quantity_changed` on the `inventory_ledger` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[client_id,service_id]` on the table `clients_services` will be added. If there are existing duplicate values, this will fail.
  - The required column `id` was added to the `clients_services` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `quantity` to the `inventory_ledger` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `movement_type` on the `inventory_ledger` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIVING', 'PUTAWAY', 'INTERNAL_MOVE', 'PICKING', 'SHIPMENT', 'ADJUSTMENT');

-- DropForeignKey
ALTER TABLE "inventory_ledger" DROP CONSTRAINT "inventory_ledger_location_id_fkey";

-- DropIndex
DROP INDEX "idx_inventory_ledger_location_time";

-- DropIndex
DROP INDEX "idx_inventory_ledger_user_time";

-- AlterTable
ALTER TABLE "inventory_ledger" DROP COLUMN "location_id",
DROP COLUMN "quantity_changed",
ADD COLUMN     "from_location_id" UUID,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL,
ADD COLUMN     "reference_id" VARCHAR(100),
ADD COLUMN     "to_location_id" UUID,
DROP COLUMN "movement_type",
ADD COLUMN     "movement_type" "InventoryMovementType" NOT NULL;

-- CreateIndex
CREATE INDEX "inventory_ledger_from_location_id_to_location_id_idx" ON "inventory_ledger"("from_location_id", "to_location_id");

-- CreateIndex
CREATE INDEX "inventory_ledger_reference_id_idx" ON "inventory_ledger"("reference_id");

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_inventory_ledger_product_time" RENAME TO "inventory_ledger_product_id_timestamp_idx";
