-- A dispatched shipment's charge, made findable from the shipment.
--
-- Dispatch writes one SHIPMENT_CHARGE line whose reference lives only in the
-- description text. Deleting a dispatched shipment now has to reverse that exact
-- line, and matching on a human-readable string is the kind of thing that breaks
-- the day someone edits the wording. This backlink lets deleteShipment find the
-- line by id instead.
--
-- Nullable, because every other line type (manual charges, FBA, recurring) has
-- no shipment. ON DELETE SET NULL is only a backstop: deleteShipment removes the
-- line inside the same transaction before the shipment row goes, so in the
-- normal path this constraint never has to act.
ALTER TABLE "invoice_line_items"
  ADD COLUMN "shipment_id" UUID;

ALTER TABLE "invoice_line_items"
  ADD CONSTRAINT "invoice_line_items_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_line_items_shipment_id" ON "invoice_line_items"("shipment_id");
