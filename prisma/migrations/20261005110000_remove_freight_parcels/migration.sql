-- Remove the parcel Freight module.
--
-- It is replaced by the Air Freight cross-dock module (a client's flight of many
-- boxes, received at a UK hub and handed to couriers). The two never overlapped
-- in production — the parcel module carried no real data — so the tables, their
-- enums and the permission grants go rather than being migrated.
--
-- The air freight module reuses the "airfreight" permission token. Any employee
-- still carrying an old "freight:*" grant is stripped of it here, so the next
-- time their permissions are saved normalisePermissions does not reject the row
-- for holding a token the closed list no longer knows.

DROP TABLE IF EXISTS "freight_receiving_records";
DROP TABLE IF EXISTS "freight_shipment_documents";
DROP TABLE IF EXISTS "freight_shipments";

DROP TYPE IF EXISTS "FreightShipmentStatus";
DROP TYPE IF EXISTS "FreightWeightUnit";

UPDATE "users"
SET "permissions" = ARRAY(
  SELECT p FROM unnest("permissions") AS p WHERE p NOT LIKE 'freight:%'
)
WHERE EXISTS (
  SELECT 1 FROM unnest("permissions") AS p WHERE p LIKE 'freight:%'
);
