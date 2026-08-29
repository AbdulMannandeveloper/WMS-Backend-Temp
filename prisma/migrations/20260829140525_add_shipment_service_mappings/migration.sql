-- CreateTable
CREATE TABLE "shipment_service_mappings" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "client_service_id" UUID,
    "quantity" DECIMAL(10,2) NOT NULL,
    "applied_unit_price" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "shipment_service_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_shipment_services_shipment_id" ON "shipment_service_mappings"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipment_service_pair" ON "shipment_service_mappings"("shipment_id", "service_id");

-- AddForeignKey
ALTER TABLE "shipment_service_mappings" ADD CONSTRAINT "shipment_service_mappings_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_service_mappings" ADD CONSTRAINT "shipment_service_mappings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_service_mappings" ADD CONSTRAINT "shipment_service_mappings_client_service_id_fkey" FOREIGN KEY ("client_service_id") REFERENCES "clients_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
