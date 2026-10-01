-- AlterTable
ALTER TABLE "fba_shipments" ADD COLUMN     "delivery_address" TEXT,
ADD COLUMN     "delivery_contact" VARCHAR(120),
ADD COLUMN     "delivery_postcode" VARCHAR(20),
ADD COLUMN     "dispatch_mode" VARCHAR(80),
ADD COLUMN     "order_reference" VARCHAR(64),
ADD COLUMN     "pallet_count" INTEGER,
ADD COLUMN     "staff_note" TEXT,
ADD COLUMN     "vehicle_registration" VARCHAR(20);

-- AlterTable
ALTER TABLE "fba_shipment_items" ADD COLUMN     "boxes" INTEGER;

-- CreateTable
CREATE TABLE "fba_shipment_services" (
    "id" UUID NOT NULL,
    "fba_shipment_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "client_service_id" UUID,
    "quantity" DECIMAL(10,2) NOT NULL,
    "applied_unit_price" DECIMAL(14,2),

    CONSTRAINT "fba_shipment_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_fba_shipment_services_shipment_id" ON "fba_shipment_services"("fba_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fba_shipment_service_pair" ON "fba_shipment_services"("fba_shipment_id", "service_id");

-- AddForeignKey
ALTER TABLE "fba_shipment_services" ADD CONSTRAINT "fba_shipment_services_fba_shipment_id_fkey" FOREIGN KEY ("fba_shipment_id") REFERENCES "fba_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fba_shipment_services" ADD CONSTRAINT "fba_shipment_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fba_shipment_services" ADD CONSTRAINT "fba_shipment_services_client_service_id_fkey" FOREIGN KEY ("client_service_id") REFERENCES "clients_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

