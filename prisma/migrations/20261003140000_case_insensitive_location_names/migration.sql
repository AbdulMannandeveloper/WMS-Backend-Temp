-- Warehouse location names (per parent) and location class names are unique
-- without regard to letter case. The names keep the case they were typed in;
-- the rule lives in expression indexes on lower(), as for product codes.
--
-- `Bin A1` and `BIN A1` on one shelf are one place to anyone standing there,
-- and they already shared a materialised path, which is a lowercase slug.
--
-- Mirrors the existing uidx_parent_location_name: NULL parents are distinct,
-- so the database leaves top-level names to the application's check, exactly
-- as before. Prisma cannot declare these; see the notes in schema.prisma.

-- Refuse to start rather than pick which of two locations is the real one.
-- Counts only; prep/check-case-collisions.sql lists them.
DO $$
DECLARE
  location_clashes integer;
  class_clashes integer;
BEGIN
  SELECT count(*) INTO location_clashes FROM (
    SELECT 1 FROM "warehouse_locations"
    WHERE "parent_location_id" IS NOT NULL
    GROUP BY "parent_location_id", lower("location_name") HAVING count(*) > 1
  ) AS t;

  SELECT count(*) INTO class_clashes FROM (
    SELECT 1 FROM "warehouse_location_classes"
    GROUP BY lower("name") HAVING count(*) > 1
  ) AS t;

  IF location_clashes + class_clashes > 0 THEN
    RAISE EXCEPTION
      'Case-insensitive location names: % location name(s) and % class name(s) are used twice in different case. Rename one of each first; prep/check-case-collisions.sql lists them.',
      location_clashes, class_clashes;
  END IF;
END $$;

CREATE UNIQUE INDEX "uq_warehouse_locations_parent_name_ci"
  ON "warehouse_locations" ("parent_location_id", lower("location_name"));

CREATE UNIQUE INDEX "uq_warehouse_location_classes_name_ci"
  ON "warehouse_location_classes" (lower("name"));
