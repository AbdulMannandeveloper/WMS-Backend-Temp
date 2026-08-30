-- FDA consignments: recorded by hand, never put away, billed per item when
-- they leave.
--
-- Deliberately not modelled as a Shipment. An FDA consignment has no product
-- in the catalogue, no stock level and no warehouse location: the goods pass
-- through rather than being stored, so there is nothing to reserve, nothing to
-- deduct and no ledger movement to write. Reusing Shipment would have meant
-- every one of those paths growing a branch for the case where none of it
-- applies.
--
-- LineItemType.FDA_CHARGE keeps the charge separable on an invoice, which is
-- the requirement: its charges are separate from ordinary dispatch.

-- CreateEnum
CREATE TYPE "FdaShipmentStatus" AS ENUM ('RECEIVED', 'DISPATCHED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "LineItemType" ADD VALUE 'FDA_CHARGE';

-- CreateTable
CREATE TABLE "fda_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fda_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fda_shipments" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "barcode" VARCHAR(64) NOT NULL,
    "size" VARCHAR(60) NOT NULL,
    "count" INTEGER NOT NULL,
    "status" "FdaShipmentStatus" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(6),
    "notes" TEXT,

    CONSTRAINT "fda_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fda_categories_name_key" ON "fda_categories"("name");

-- CreateIndex
CREATE INDEX "idx_fda_shipments_client_status" ON "fda_shipments"("client_id", "status");

-- CreateIndex
CREATE INDEX "idx_fda_shipments_barcode" ON "fda_shipments"("barcode");

-- AddForeignKey
ALTER TABLE "fda_shipments" ADD CONSTRAINT "fda_shipments_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "fda_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fda_shipments" ADD CONSTRAINT "fda_shipments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

