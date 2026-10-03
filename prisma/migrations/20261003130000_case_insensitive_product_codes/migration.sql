-- SKUs (per client) and product barcodes are unique without regard to letter
-- case. Unlike emails they keep the spelling they were entered in — a SKU is
-- the client's own identifier, printed on their paperwork — so the rule lives
-- in expression indexes on lower() rather than in a rewrite of the data.
--
-- Before this, the screens already refused `abc-1` beside `ABC-1` but the
-- database did not, so anything that skipped the screens (the API, a bulk
-- check-in line) could create a second product nobody could tell apart, and a
-- scan typed in the other case found nothing.
--
-- Prisma's schema cannot express an index on an expression. These are declared
-- here only; see the note on the Product model in schema.prisma.

-- Refuse to start rather than pick which of two products is the real one.
-- Counts only; prep/check-case-collisions.sql lists them.
DO $$
DECLARE
  sku_clashes integer;
  barcode_clashes integer;
BEGIN
  SELECT count(*) INTO sku_clashes FROM (
    SELECT 1 FROM "products"
    GROUP BY "client_id", lower(btrim("sku_code")) HAVING count(*) > 1
  ) AS t;

  SELECT count(*) INTO barcode_clashes FROM (
    SELECT 1 FROM "products"
    WHERE NULLIF(btrim("barcode"), '') IS NOT NULL
    GROUP BY lower(btrim("barcode")) HAVING count(*) > 1
  ) AS t;

  IF sku_clashes + barcode_clashes > 0 THEN
    RAISE EXCEPTION
      'Case-insensitive product codes: % SKU(s) and % barcode(s) are held by more than one product in different spellings. Resolve them first; prep/check-case-collisions.sql lists them.',
      sku_clashes, barcode_clashes;
  END IF;
END $$;

-- Stray spaces are never part of a code; the application trims from here on.
UPDATE "products"
SET "sku_code" = btrim("sku_code")
WHERE "sku_code" <> btrim("sku_code");

-- A blank barcode is no barcode. Left as '', a second blank would collide with
-- the first on the unique index.
UPDATE "products"
SET "barcode" = NULLIF(btrim("barcode"), '')
WHERE "barcode" IS DISTINCT FROM NULLIF(btrim("barcode"), '');

CREATE UNIQUE INDEX "uq_products_client_sku_ci" ON "products" ("client_id", lower("sku_code"));

CREATE UNIQUE INDEX "uq_products_barcode_ci" ON "products" (lower("barcode"));
