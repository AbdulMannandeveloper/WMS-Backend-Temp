-- The Air Freight cross-dock module.
--
-- A client's flight of many boxes, received at a UK hub by scan, sorted by
-- courier, and handed to courier depots. Couriers and their depots, per-client
-- billing/notification settings, flights, manifest uploads, boxes, their
-- append-only event history, courier handovers, and exceptions.
--
-- The tables and most indexes below were generated from the Prisma schema. The
-- one thing Prisma cannot express — the partial unique index on box tracking
-- numbers — is added by hand at the end. Because that index lives only here,
-- never run `prisma migrate dev` against this project: it would see the index as
-- drift and generate a DROP for it. `prisma migrate deploy` (prod and tests)
-- does no drift check.

-- CreateEnum
CREATE TYPE "AirFreightFlightStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'LANDED', 'CUSTOMS_HOLD', 'CLEARED', 'RECEIVING', 'RECEIVED', 'RECEIVED_PARTIAL', 'IN_DELIVERY', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AirFreightBoxStatus" AS ENUM ('MANIFESTED', 'DISPATCHED', 'LANDED', 'CUSTOMS_HOLD', 'CLEARED', 'RECEIVED', 'ON_HOLD', 'ON_HANDOVER', 'HANDED_TO_COURIER', 'SHORT', 'REFUSED_AT_DEPOT', 'RETURNED_TO_CLIENT', 'WRITTEN_OFF', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AirFreightEventSource" AS ENUM ('CSV', 'SCAN', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AirFreightUploadStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "AirFreightUploadMode" AS ENUM ('REPLACE', 'APPEND');

-- CreateEnum
CREATE TYPE "AirFreightHandoverStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AirFreightExceptionType" AS ENUM ('SHORT', 'OVER', 'DAMAGED', 'LABEL_UNREADABLE', 'WRONG_COURIER', 'CUSTOMS_HOLD', 'REFUSED_AT_DEPOT');

-- CreateEnum
CREATE TYPE "AirFreightExceptionStatus" AS ENUM ('OPEN', 'AWAITING_CLIENT', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AirFreightResolution" AS ENUM ('FOUND', 'WRITTEN_OFF', 'ADDED_TO_MANIFEST', 'RETURNED_TO_CLIENT', 'SHIPPED_AS_IS', 'RELABELLED', 'RELEASED', 'REPACKED');

-- CreateEnum
CREATE TYPE "AirFreightClientDecision" AS ENUM ('SHIP_AS_IS', 'HOLD', 'RETURN', 'NEW_LABEL');

-- CreateEnum
CREATE TYPE "AirFreightBillingStatus" AS ENUM ('NOT_READY', 'READY', 'POSTED');

-- CreateEnum
CREATE TYPE "ChargeableWeightMethod" AS ENUM ('PER_BOX', 'FLIGHT_TOTAL');

-- AlterTable
ALTER TABLE "invoice_line_items" ADD COLUMN     "air_freight_flight_id" UUID;

-- CreateTable
CREATE TABLE "couriers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "tracking_regex" VARCHAR(255),
    "tracking_url_template" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "couriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_depots" (
    "id" UUID NOT NULL,
    "courier_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "courier_depots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_client_settings" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "chargeable_weight_method" "ChargeableWeightMethod" NOT NULL DEFAULT 'PER_BOX',
    "volumetric_divisor" INTEGER NOT NULL DEFAULT 6000,
    "rounding_increment_kg" DECIMAL(4,2) NOT NULL DEFAULT 0.50,
    "free_storage_hours" INTEGER NOT NULL DEFAULT 48,
    "email_notifications" BOOLEAN NOT NULL DEFAULT false,
    "notification_email" VARCHAR(255),
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "air_freight_client_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_flights" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "mawb_number" VARCHAR(20),
    "airline" VARCHAR(80),
    "flight_number" VARCHAR(20),
    "origin_location" VARCHAR(120) NOT NULL,
    "destination_location" VARCHAR(120) NOT NULL,
    "etd" TIMESTAMPTZ(6),
    "eta" TIMESTAMPTZ(6),
    "declared_pieces" INTEGER,
    "declared_weight_kg" DECIMAL(10,3),
    "notes" TEXT,
    "status" "AirFreightFlightStatus" NOT NULL DEFAULT 'DRAFT',
    "dispatched_at" TIMESTAMPTZ(6),
    "landed_at" TIMESTAMPTZ(6),
    "customs_hold_at" TIMESTAMPTZ(6),
    "cleared_at" TIMESTAMPTZ(6),
    "receipt_closed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "created_by_user_id" UUID,
    "dispatched_by_user_id" UUID,
    "landed_by_user_id" UUID,
    "cleared_by_user_id" UUID,
    "receipt_closed_by_user_id" UUID,
    "cancelled_by_user_id" UUID,
    "notified_milestones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "billing_status" "AirFreightBillingStatus" NOT NULL DEFAULT 'NOT_READY',
    "billing_posted_at" TIMESTAMPTZ(6),
    "billing_posted_by_user_id" UUID,
    "billing_post_reason" TEXT,
    "billing_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "air_freight_flights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_uploads" (
    "id" UUID NOT NULL,
    "flight_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "file_type" VARCHAR(120) NOT NULL,
    "mode" "AirFreightUploadMode" NOT NULL,
    "status" "AirFreightUploadStatus" NOT NULL DEFAULT 'PREVIEW',
    "rows_total" INTEGER NOT NULL,
    "rows_ok" INTEGER NOT NULL,
    "rows_error" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "version" INTEGER,
    "uploaded_by_user_id" UUID,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMPTZ(6),

    CONSTRAINT "air_freight_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_boxes" (
    "id" UUID NOT NULL,
    "flight_id" UUID NOT NULL,
    "courier_id" UUID NOT NULL,
    "tracking_number" VARCHAR(64) NOT NULL,
    "previous_tracking_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_reference" VARCHAR(80),
    "reference" VARCHAR(80),
    "declared_weight_kg" DECIMAL(10,3) NOT NULL,
    "length_cm" DECIMAL(8,1) NOT NULL,
    "width_cm" DECIMAL(8,1) NOT NULL,
    "height_cm" DECIMAL(8,1) NOT NULL,
    "measured_weight_kg" DECIMAL(10,3),
    "measured_length_cm" DECIMAL(8,1),
    "measured_width_cm" DECIMAL(8,1),
    "measured_height_cm" DECIMAL(8,1),
    "measured_by_user_id" UUID,
    "measured_at" TIMESTAMPTZ(6),
    "contents_description" VARCHAR(255) NOT NULL,
    "hs_code" VARCHAR(10),
    "declared_value" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "consignee_name" VARCHAR(160) NOT NULL,
    "consignee_postcode" VARCHAR(20) NOT NULL,
    "status" "AirFreightBoxStatus" NOT NULL DEFAULT 'MANIFESTED',
    "status_before_hold" "AirFreightBoxStatus",
    "hold_scope" VARCHAR(10),
    "current_location" VARCHAR(120),
    "received_at" TIMESTAMPTZ(6),
    "received_by_user_id" UUID,
    "handover_id" UUID,
    "handed_over_at" TIMESTAMPTZ(6),
    "returned_at" TIMESTAMPTZ(6),
    "written_off_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "air_freight_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_box_events" (
    "id" UUID NOT NULL,
    "box_id" UUID NOT NULL,
    "flight_id" UUID NOT NULL,
    "from_status" "AirFreightBoxStatus",
    "to_status" "AirFreightBoxStatus",
    "event_type" VARCHAR(40) NOT NULL,
    "source" "AirFreightEventSource" NOT NULL,
    "user_id" UUID,
    "location" VARCHAR(120),
    "note" TEXT,
    "photo_key" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "air_freight_box_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_handovers" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "courier_id" UUID NOT NULL,
    "depot_id" UUID,
    "depot_name" VARCHAR(120) NOT NULL,
    "vehicle_reg" VARCHAR(20),
    "driver_name" VARCHAR(120),
    "status" "AirFreightHandoverStatus" NOT NULL DEFAULT 'OPEN',
    "confirmed_count" INTEGER,
    "depot_staff_name" VARCHAR(120),
    "close_note" TEXT,
    "proof_photo_key" VARCHAR(255),
    "box_snapshot" JSONB,
    "opened_by_user_id" UUID,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "air_freight_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "air_freight_exceptions" (
    "id" UUID NOT NULL,
    "flight_id" UUID NOT NULL,
    "box_id" UUID,
    "type" "AirFreightExceptionType" NOT NULL,
    "status" "AirFreightExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "scanned_code" VARCHAR(64),
    "owner_role" VARCHAR(20) NOT NULL,
    "raised_by_user_id" UUID,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "internal_note" TEXT,
    "client_note" TEXT,
    "photo_key" VARCHAR(255),
    "client_decision" "AirFreightClientDecision",
    "client_decision_note" TEXT,
    "client_decided_at" TIMESTAMPTZ(6),
    "client_label_key" VARCHAR(255),
    "resolution" "AirFreightResolution",
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "chargeable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "air_freight_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_couriers_code" ON "couriers"("code");

-- CreateIndex
CREATE INDEX "idx_couriers_active" ON "couriers"("is_active");

-- CreateIndex
CREATE INDEX "idx_courier_depots_courier" ON "courier_depots"("courier_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_courier_depots_courier_name" ON "courier_depots"("courier_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_af_client_settings_client" ON "air_freight_client_settings"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_air_freight_flights_reference" ON "air_freight_flights"("reference");

-- CreateIndex
CREATE INDEX "idx_af_flights_client_created_at" ON "air_freight_flights"("client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_af_flights_status_created_at" ON "air_freight_flights"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_af_flights_mawb" ON "air_freight_flights"("mawb_number");

-- CreateIndex
CREATE INDEX "idx_af_flights_created_at" ON "air_freight_flights"("created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "idx_af_uploads_flight_uploaded_at" ON "air_freight_uploads"("flight_id", "uploaded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_af_boxes_flight_status" ON "air_freight_boxes"("flight_id", "status");

-- CreateIndex
CREATE INDEX "idx_af_boxes_courier_status" ON "air_freight_boxes"("courier_id", "status");

-- CreateIndex
CREATE INDEX "idx_af_boxes_handover" ON "air_freight_boxes"("handover_id");

-- CreateIndex
CREATE INDEX "idx_af_boxes_client_reference" ON "air_freight_boxes"("client_reference");

-- CreateIndex
CREATE INDEX "idx_af_boxes_reference" ON "air_freight_boxes"("reference");

-- CreateIndex
CREATE INDEX "idx_af_box_events_box_created_at" ON "air_freight_box_events"("box_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_af_box_events_flight_created_at" ON "air_freight_box_events"("flight_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_af_handovers_reference" ON "air_freight_handovers"("reference");

-- CreateIndex
CREATE INDEX "idx_af_handovers_status_opened_at" ON "air_freight_handovers"("status", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "idx_af_handovers_courier_opened_at" ON "air_freight_handovers"("courier_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "idx_af_exceptions_status_raised_at" ON "air_freight_exceptions"("status", "raised_at");

-- CreateIndex
CREATE INDEX "idx_af_exceptions_flight_status" ON "air_freight_exceptions"("flight_id", "status");

-- CreateIndex
CREATE INDEX "idx_af_exceptions_type_status" ON "air_freight_exceptions"("type", "status");

-- CreateIndex
CREATE INDEX "idx_af_exceptions_box" ON "air_freight_exceptions"("box_id");

-- CreateIndex
CREATE INDEX "idx_line_items_air_freight_flight_id" ON "invoice_line_items"("air_freight_flight_id");

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_air_freight_flight_id_fkey" FOREIGN KEY ("air_freight_flight_id") REFERENCES "air_freight_flights"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_depots" ADD CONSTRAINT "courier_depots_courier_id_fkey" FOREIGN KEY ("courier_id") REFERENCES "couriers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_client_settings" ADD CONSTRAINT "air_freight_client_settings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_flights" ADD CONSTRAINT "air_freight_flights_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_uploads" ADD CONSTRAINT "air_freight_uploads_flight_id_fkey" FOREIGN KEY ("flight_id") REFERENCES "air_freight_flights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_boxes" ADD CONSTRAINT "air_freight_boxes_flight_id_fkey" FOREIGN KEY ("flight_id") REFERENCES "air_freight_flights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_boxes" ADD CONSTRAINT "air_freight_boxes_courier_id_fkey" FOREIGN KEY ("courier_id") REFERENCES "couriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_boxes" ADD CONSTRAINT "air_freight_boxes_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "air_freight_handovers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_box_events" ADD CONSTRAINT "air_freight_box_events_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "air_freight_boxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_box_events" ADD CONSTRAINT "air_freight_box_events_flight_id_fkey" FOREIGN KEY ("flight_id") REFERENCES "air_freight_flights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_handovers" ADD CONSTRAINT "air_freight_handovers_courier_id_fkey" FOREIGN KEY ("courier_id") REFERENCES "couriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_handovers" ADD CONSTRAINT "air_freight_handovers_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "courier_depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "air_freight_exceptions" ADD CONSTRAINT "air_freight_exceptions_flight_id_fkey" FOREIGN KEY ("flight_id") REFERENCES "air_freight_flights"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A box's tracking number is unique only among ACTIVE boxes. Couriers recycle
-- numbers over time, and a box that has left (handed over, returned or written
-- off) or was cancelled must not block that number from appearing on a future
-- flight. Prisma has no partial-index syntax, so this is hand-written and the
-- schema carries no @unique for it. Keep this predicate in step with
-- ACTIVE_BOX_STATUSES in repositories/air_freight_box.repository.js.
CREATE UNIQUE INDEX "uq_air_freight_boxes_tracking_active"
  ON "air_freight_boxes" ("tracking_number")
  WHERE "status" NOT IN ('CANCELLED', 'HANDED_TO_COURIER', 'RETURNED_TO_CLIENT', 'WRITTEN_OFF');
