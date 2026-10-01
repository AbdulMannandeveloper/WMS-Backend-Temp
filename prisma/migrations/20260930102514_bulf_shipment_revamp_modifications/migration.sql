-- AlterTable
ALTER TABLE "freight_receiving_records" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "freight_shipment_documents" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "freight_shipments" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;
