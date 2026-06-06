/*
  Warnings:

  - You are about to drop the column `additional_charges` on the `monthly_invoices` table. All the data in the column will be lost.
  - The `status` column on the `monthly_invoices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[client_id,billing_period]` on the table `monthly_invoices` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `billing_period` to the `monthly_invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `monthly_invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `client_id` to the `shipments` table without a default value. This is not possible if the table is not empty.
  - Added the required column `applied_unit_price` to the `shipments_services_mapping` table without a default value. This is not possible if the table is not empty.
  - Added the required column `quantity` to the `shipments_services_mapping` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "LineItemType" AS ENUM ('AUTOMATED_SERVICE', 'MANUAL_CHARGE');

-- AlterTable
ALTER TABLE "monthly_invoices" DROP COLUMN "additional_charges",
ADD COLUMN     "approved_at" TIMESTAMPTZ(6),
ADD COLUMN     "billing_period" DATE NOT NULL,
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "client_id" UUID NOT NULL,
ALTER COLUMN "shipment_type" SET DATA TYPE VARCHAR(30),
ALTER COLUMN "packaging_type" SET DATA TYPE VARCHAR(30);

-- AlterTable
ALTER TABLE "shipments_services_mapping" ADD COLUMN     "applied_unit_price" DECIMAL(14,2) NOT NULL,
ADD COLUMN     "quantity" DECIMAL(10,2) NOT NULL;

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "item_type" "LineItemType" NOT NULL,
    "date_of_service" DATE NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "total_price" DECIMAL(14,2) NOT NULL,
    "client_service_id" UUID,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_line_items_invoice_date" ON "invoice_line_items"("invoice_id", "date_of_service");

-- CreateIndex
CREATE INDEX "idx_monthly_invoices_client_status" ON "monthly_invoices"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uidx_client_billing_period" ON "monthly_invoices"("client_id", "billing_period");

-- CreateIndex
CREATE INDEX "idx_shipments_client_created_at" ON "shipments"("client_id", "created_at");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "monthly_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_client_service_id_fkey" FOREIGN KEY ("client_service_id") REFERENCES "clients_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
