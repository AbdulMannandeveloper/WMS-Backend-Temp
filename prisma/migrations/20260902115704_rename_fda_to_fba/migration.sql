-- FDA -> FBA. These consignments are Fulfilment By Amazon, not Food and Drug
-- Administration; the original name was wrong from the start.
--
-- Renames throughout rather than drop-and-recreate: there are already
-- categories, consignments and at least one invoice line in existence, and
-- dropping the tables would destroy billing history. Every statement below
-- preserves its rows.
--
-- ALTER TYPE ... RENAME VALUE needs Postgres 10+; this runs on 18.

-- Tables
ALTER TABLE "fda_categories" RENAME TO "fba_categories";
ALTER TABLE "fda_shipments" RENAME TO "fba_shipments";

-- Enum type, and the LineItemType member. Renaming the value keeps every
-- existing invoice line pointing at it, which a drop-and-add would not.
ALTER TYPE "FdaShipmentStatus" RENAME TO "FbaShipmentStatus";
ALTER TYPE "LineItemType" RENAME VALUE 'FDA_CHARGE' TO 'FBA_CHARGE';

-- Indexes and constraints keep their old names through a table rename, and
-- Prisma compares them by name, so they are renamed to match the schema.
ALTER INDEX "idx_fda_shipments_client_status" RENAME TO "idx_fba_shipments_client_status";
ALTER INDEX "idx_fda_shipments_barcode" RENAME TO "idx_fba_shipments_barcode";
ALTER INDEX "fda_categories_pkey" RENAME TO "fba_categories_pkey";
ALTER INDEX "fda_shipments_pkey" RENAME TO "fba_shipments_pkey";
ALTER INDEX "fda_categories_name_key" RENAME TO "fba_categories_name_key";

ALTER TABLE "fba_shipments" RENAME CONSTRAINT "fda_shipments_category_id_fkey" TO "fba_shipments_category_id_fkey";
ALTER TABLE "fba_shipments" RENAME CONSTRAINT "fda_shipments_client_id_fkey" TO "fba_shipments_client_id_fkey";

-- The catalogue row is data, not schema. Without this the rate an admin already
-- agreed with a client stops being found, and consignments quietly stop being
-- charged — the exact failure that made shipment billing unreachable before.
UPDATE "services" SET "code" = 'FBA_DISPATCH' WHERE "code" = 'FDA_DISPATCH';
UPDATE "services" SET "description" = 'FBA consignment (per item)' WHERE "code" = 'FBA_DISPATCH';
