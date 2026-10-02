-- A bulk shipment line's Return button books a return record, like an outbound
-- line's. The record names the bulk shipment and line it came back from.
ALTER TABLE "product_returns" ADD COLUMN "fba_shipment_id" UUID;
ALTER TABLE "product_returns" ADD COLUMN "fba_shipment_item_id" UUID;

CREATE INDEX "idx_product_returns_fba_shipment_id" ON "product_returns"("fba_shipment_id");
CREATE INDEX "idx_product_returns_fba_shipment_item_id" ON "product_returns"("fba_shipment_item_id");

ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_fba_shipment_id_fkey" FOREIGN KEY ("fba_shipment_id") REFERENCES "fba_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_returns" ADD CONSTRAINT "product_returns_fba_shipment_item_id_fkey" FOREIGN KEY ("fba_shipment_item_id") REFERENCES "fba_shipment_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
