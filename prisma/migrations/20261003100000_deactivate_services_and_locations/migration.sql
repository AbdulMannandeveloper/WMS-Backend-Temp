-- Services, warehouse locations and location classes that records still point
-- at cannot be deleted. Deactivating keeps them for those records and takes
-- them out of everything new.
ALTER TABLE "services" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "warehouse_locations" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "warehouse_location_classes" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
