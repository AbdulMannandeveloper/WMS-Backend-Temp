/*
  Warnings:

  - A unique constraint covering the columns `[parent_location_id,location_name]` on the table `warehouse_locations` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `location_class` on the `warehouse_locations` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "LocationClass" AS ENUM ('ZONE', 'AISLE', 'BAY', 'SHELF', 'BIN', 'STAGING', 'RECEIVING', 'SHIPPING');

-- AlterTable
ALTER TABLE "employees" ALTER COLUMN "job_title" DROP NOT NULL,
ALTER COLUMN "national_insurance_number" DROP NOT NULL,
ALTER COLUMN "date_of_birth" DROP NOT NULL,
ALTER COLUMN "wage_rate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "warehouse_locations" ADD COLUMN     "materialized_path" VARCHAR(500),
DROP COLUMN "location_class",
ADD COLUMN     "location_class" "LocationClass" NOT NULL;

-- CreateIndex
CREATE INDEX "idx_warehouse_materialized_path" ON "warehouse_locations"("materialized_path");

-- CreateIndex
CREATE UNIQUE INDEX "uidx_parent_location_name" ON "warehouse_locations"("parent_location_id", "location_name");
