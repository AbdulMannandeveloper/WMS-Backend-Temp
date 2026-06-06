-- CreateTable
CREATE TABLE "warehouse_location_classes" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(255),
    "parent_class_id" UUID,

    CONSTRAINT "warehouse_location_classes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_location_classes_name_key" ON "warehouse_location_classes"("name");

-- CreateIndex
CREATE INDEX "idx_warehouse_location_classes_parent_class_id" ON "warehouse_location_classes"("parent_class_id");

-- Seed initial classes for the existing warehouse hierarchy
INSERT INTO "warehouse_location_classes" ("id", "name", "parent_class_id")
VALUES
    ('11111111-1111-1111-1111-111111111111', 'ZONE', NULL),
    ('22222222-2222-2222-2222-222222222222', 'AISLE', '11111111-1111-1111-1111-111111111111'),
    ('33333333-3333-3333-3333-333333333333', 'SHELF', '22222222-2222-2222-2222-222222222222'),
    ('44444444-4444-4444-4444-444444444444', 'BIN', '33333333-3333-3333-3333-333333333333');

-- AlterTable
ALTER TABLE "warehouse_locations" ADD COLUMN "location_class_id" UUID;

UPDATE "warehouse_locations" wl
SET "location_class_id" = wlc."id"
FROM "warehouse_location_classes" wlc
WHERE wlc."name" = wl."location_class"::text;

ALTER TABLE "warehouse_locations" ALTER COLUMN "location_class_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "idx_warehouse_location_class_id" ON "warehouse_locations"("location_class_id");

-- AddForeignKey
ALTER TABLE "warehouse_locations"
ADD CONSTRAINT "warehouse_locations_location_class_id_fkey"
FOREIGN KEY ("location_class_id") REFERENCES "warehouse_location_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_location_classes"
ADD CONSTRAINT "warehouse_location_classes_parent_class_id_fkey"
FOREIGN KEY ("parent_class_id") REFERENCES "warehouse_location_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Drop old enum-backed column and type
ALTER TABLE "warehouse_locations" DROP COLUMN "location_class";
DROP TYPE IF EXISTS "LocationClass";
