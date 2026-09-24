-- The bulk-shipment flow: FBA becomes a multi-step, multi-product shipment.
--
-- The single-consignment record (one barcode, size and count) is replaced by a
-- shell that products are scanned into over three steps — create, prepare,
-- dispatch. The old columns stay for existing rows but become nullable, and the
-- goods now live in a child table, fba_shipment_items. (Enum values DRAFT and
-- PREPARING were added in the preceding migration.)

-- New rows start in DRAFT. The old default was RECEIVED; the values were
-- committed by the previous migration so they can be referenced here.
ALTER TABLE "fba_shipments" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- The old single-consignment fields are no longer required.
ALTER TABLE "fba_shipments" ALTER COLUMN "barcode" DROP NOT NULL;
ALTER TABLE "fba_shipments" ALTER COLUMN "size" DROP NOT NULL;
ALTER TABLE "fba_shipments" ALTER COLUMN "count" DROP NOT NULL;

-- New shell fields.
ALTER TABLE "fba_shipments" ADD COLUMN "destination" VARCHAR(160);
ALTER TABLE "fba_shipments" ADD COLUMN "delivery_note" TEXT;
ALTER TABLE "fba_shipments" ADD COLUMN "tracking_id" VARCHAR(64);
ALTER TABLE "fba_shipments" ADD COLUMN "created_by_user_id" UUID;
ALTER TABLE "fba_shipments" ADD COLUMN "prepared_by_user_id" UUID;
ALTER TABLE "fba_shipments" ADD COLUMN "dispatched_by_user_id" UUID;

-- The bulk-shipment number. Added nullable, backfilled for existing rows, then
-- tightened to NOT NULL + UNIQUE — the established pattern for a required unique
-- column on a table that already has data.
ALTER TABLE "fba_shipments" ADD COLUMN "reference" VARCHAR(64);

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY received_at, id) AS rn
  FROM "fba_shipments"
  WHERE "reference" IS NULL
)
UPDATE "fba_shipments" f
SET "reference" = 'BULK-' || to_char(f."received_at", 'YYYY') || '-' || lpad(numbered.rn::text, 6, '0')
FROM numbered
WHERE f.id = numbered.id;

ALTER TABLE "fba_shipments" ALTER COLUMN "reference" SET NOT NULL;
CREATE UNIQUE INDEX "uq_fba_shipments_reference" ON "fba_shipments"("reference");

-- The scanned products, one row per (shipment, product, bin).
CREATE TABLE "fba_shipment_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fba_shipment_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "source_location_id" UUID NOT NULL,
  "barcode" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "fba_shipment_items_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "fba_shipment_items"
  ADD CONSTRAINT "fba_shipment_items_fba_shipment_id_fkey"
  FOREIGN KEY ("fba_shipment_id") REFERENCES "fba_shipments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fba_shipment_items"
  ADD CONSTRAINT "fba_shipment_items_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fba_shipment_items"
  ADD CONSTRAINT "fba_shipment_items_source_location_id_fkey"
  FOREIGN KEY ("source_location_id") REFERENCES "warehouse_locations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "idx_fba_shipment_items_shipment" ON "fba_shipment_items"("fba_shipment_id");
CREATE INDEX "idx_fba_shipment_items_product" ON "fba_shipment_items"("product_id");
