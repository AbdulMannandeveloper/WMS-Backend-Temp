-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('RECORDED', 'DISPOSED', 'RESTOCKED');

-- AlterTable
ALTER TABLE "invoice_line_items" ADD COLUMN     "return_id" UUID;

-- CreateTable
CREATE TABLE "product_returns" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "tracking_number" VARCHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'RECORDED',
    "shipment_id" UUID,
    "shipment_item_id" UUID,
    "restock_location_id" UUID,
    "notes" TEXT,
    "disposition_notes" TEXT,
    "recorded_by_user_id" UUID,
    "resolved_by_user_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_returns_reference" ON "product_returns"("reference");

-- CreateIndex
CREATE INDEX "idx_product_returns_recorded_at" ON "product_returns"("recorded_at" DESC, "id");

-- CreateIndex
CREATE INDEX "idx_product_returns_status_recorded_at" ON "product_returns"("status", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_product_returns_client_recorded_at" ON "product_returns"("client_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_product_returns_tracking_number" ON "product_returns"("tracking_number");

-- CreateIndex
CREATE INDEX "idx_product_returns_product_id" ON "product_returns"("product_id");

-- CreateIndex
CREATE INDEX "idx_product_returns_shipment_item_id" ON "product_returns"("shipment_item_id");

-- CreateIndex
CREATE INDEX "idx_line_items_return_id" ON "invoice_line_items"("return_id");

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "product_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_shipment_item_id_fkey" FOREIGN KEY ("shipment_item_id") REFERENCES "shipment_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_restock_location_id_fkey" FOREIGN KEY ("restock_location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

