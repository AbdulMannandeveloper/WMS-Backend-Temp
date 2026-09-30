-- The Pakistan → UK freight leg.
--
-- Three new tables and two new types. Nothing to backfill: this leg was not
-- recorded anywhere before, which is the whole problem — a parcel arrived at the
-- UK bench and there was nothing to match it against, so nobody could say who
-- had sent it.
--
-- Unlike the bulk_shipment_enum migration, the enums are created here rather
-- than in a file of their own. That split was needed because Postgres refuses to
-- reference a value ADDed to an *existing* type in the same transaction; a type
-- created in this transaction can be used as a column default straight away.

CREATE TYPE "FreightShipmentStatus" AS ENUM ('BOOKED', 'DISPATCHED', 'RECEIVED', 'CANCELLED');
CREATE TYPE "FreightWeightUnit" AS ENUM ('KG', 'LB');

CREATE TABLE "freight_shipments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" VARCHAR(64) NOT NULL,
    "barcode" VARCHAR(64) NOT NULL,
    "sender_name" VARCHAR(160) NOT NULL,
    "sender_contact" VARCHAR(40) NOT NULL,
    "sender_address" TEXT NOT NULL,
    "receiver_name" VARCHAR(160) NOT NULL,
    "receiver_contact" VARCHAR(40) NOT NULL,
    "receiver_address" TEXT NOT NULL,
    "destination_country" VARCHAR(80) NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "weight" DECIMAL(10,3) NOT NULL,
    "weight_unit" "FreightWeightUnit" NOT NULL DEFAULT 'KG',
    "remarks" TEXT,
    "status" "FreightShipmentStatus" NOT NULL DEFAULT 'BOOKED',
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "dispatched_by_user_id" UUID,
    "cancelled_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "freight_shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "freight_shipment_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "freight_shipment_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "file_type" VARCHAR(120) NOT NULL,
    "uploaded_by_user_id" UUID,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "freight_shipment_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "freight_receiving_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "freight_shipment_id" UUID NOT NULL,
    "barcode" VARCHAR(64) NOT NULL,
    "received_by_user_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actual_weight" DECIMAL(10,3),
    "actual_weight_unit" "FreightWeightUnit",
    "remarks" TEXT,

    CONSTRAINT "freight_receiving_records_pkey" PRIMARY KEY ("id")
);

-- The reference is the number staff read aloud; the barcode is what the gun
-- reads. Both unique, because two parcels sharing either cannot be told apart
-- afterwards by anyone.
CREATE UNIQUE INDEX "uq_freight_shipments_reference" ON "freight_shipments"("reference");
CREATE UNIQUE INDEX "uq_freight_shipments_barcode" ON "freight_shipments"("barcode");

-- Keyset ordering for the list, then the filters the list offers.
CREATE INDEX "idx_freight_shipments_created_at" ON "freight_shipments"("created_at" DESC, "id");
CREATE INDEX "idx_freight_shipments_status_created_at" ON "freight_shipments"("status", "created_at" DESC);
CREATE INDEX "idx_freight_shipments_sender_name" ON "freight_shipments"("sender_name");
CREATE INDEX "idx_freight_shipments_receiver_name" ON "freight_shipments"("receiver_name");

CREATE INDEX "idx_freight_shipment_documents_shipment" ON "freight_shipment_documents"("freight_shipment_id", "uploaded_at" DESC);

-- One receiving record per shipment, enforced here rather than only in the
-- application: this is what makes "already-received shipments cannot accidentally
-- be received again" true when two benches scan the same parcel at once.
CREATE UNIQUE INDEX "uq_freight_receiving_records_shipment" ON "freight_receiving_records"("freight_shipment_id");
CREATE INDEX "idx_freight_receiving_records_received_at" ON "freight_receiving_records"("received_at" DESC, "id");
CREATE INDEX "idx_freight_receiving_records_barcode" ON "freight_receiving_records"("barcode");

-- Cascade: a document or a receiving record has no meaning without its
-- shipment. The shipment itself refuses to be hard-deleted once received, so
-- this cascade only ever fires for a mis-keyed booking nobody has touched.
ALTER TABLE "freight_shipment_documents"
  ADD CONSTRAINT "freight_shipment_documents_freight_shipment_id_fkey"
  FOREIGN KEY ("freight_shipment_id") REFERENCES "freight_shipments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "freight_receiving_records"
  ADD CONSTRAINT "freight_receiving_records_freight_shipment_id_fkey"
  FOREIGN KEY ("freight_shipment_id") REFERENCES "freight_shipments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
