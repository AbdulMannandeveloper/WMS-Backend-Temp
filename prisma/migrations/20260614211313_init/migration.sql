/*
  Warnings:

  - You are about to drop the `shipments_services_mapping` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
ALTER TYPE "LineItemType" ADD VALUE 'SHIPMENT_CHARGE';

-- DropForeignKey
ALTER TABLE "shipments_services_mapping" DROP CONSTRAINT "shipments_services_mapping_service_id_fkey";

-- DropForeignKey
ALTER TABLE "shipments_services_mapping" DROP CONSTRAINT "shipments_services_mapping_shipment_id_fkey";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "fixed_shipment_rate" DECIMAL(12,2) NOT NULL DEFAULT 0.0;

-- DropTable
DROP TABLE "shipments_services_mapping";
