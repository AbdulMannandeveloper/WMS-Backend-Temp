-- Dispatch, rebuilt around what is actually known at the bench.
--
-- Three fields came off the creation form because they are not knowable then:
-- the shipment type and packaging are decided while packing, and the courier is
-- decided when the collection is booked. They are dropped rather than moved.
--
-- Two are added. `reference` is the label scanned off the parcel, and it is
-- unique because two shipments sharing an identity cannot be told apart
-- afterwards by the warehouse, the courier or a client querying an invoice.
-- `created_by_user_id` records whoever was signed in: employee_id pointed at
-- the Employee table, and neither admin account has a row there, so an admin
-- could not dispatch at all.
--
-- Order matters below. The backfills run while the old columns still exist and
-- before `reference` is made NOT NULL, so no row is ever momentarily invalid.

ALTER TABLE "shipments" ADD COLUMN "reference" VARCHAR(64);
ALTER TABLE "shipments" ADD COLUMN "created_by_user_id" UUID;

-- Keep the history: the shipments written before this knew their employee, and
-- an Employee row knows its user.
UPDATE "shipments" s
   SET "created_by_user_id" = e."user_id"
  FROM "employees" e
 WHERE e."id" = s."employee_id"
   AND s."created_by_user_id" IS NULL;

-- Existing rows predate the scanned label. A synthetic reference keeps them
-- addressable and satisfies the NOT NULL below; the prefix makes it obvious
-- these were never scanned.
UPDATE "shipments"
   SET "reference" = 'LEGACY-' || LEFT("id"::text, 8)
 WHERE "reference" IS NULL;

ALTER TABLE "shipments" ALTER COLUMN "reference" SET NOT NULL;
CREATE UNIQUE INDEX "uq_shipments_reference" ON "shipments"("reference");

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Optional from here. Deleting the user who dispatched a parcel must not take
-- the shipment with them, and an admin has no employee row to point at.
ALTER TABLE "shipments" ALTER COLUMN "employee_id" DROP NOT NULL;

ALTER TABLE "shipments" DROP COLUMN "shipment_type";
ALTER TABLE "shipments" DROP COLUMN "packaging_type";
ALTER TABLE "shipments" DROP COLUMN "courier_name";
