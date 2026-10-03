-- Expense categories, bulk-shipment (FBA) categories and shift names are
-- unique without regard to letter case. Names keep the case they were typed
-- in; the rule lives in expression indexes on lower(), as for locations.
--
-- Shift names had no unique rule in the database at all, only an exact check
-- in the application, so `Morning` and `morning` could both exist. Check-in
-- finds its shift by the name "default", so the index also guarantees there is
-- only ever one shift it could mean. Prisma cannot declare these; see the
-- notes in schema.prisma.

-- Refuse to start rather than pick which of two is the real one.
-- Counts only; prep/check-case-collisions.sql lists them.
DO $$
DECLARE
  expense_clashes integer;
  fba_clashes integer;
  shift_clashes integer;
BEGIN
  SELECT count(*) INTO expense_clashes FROM (
    SELECT 1 FROM "expense_categories"
    GROUP BY lower("category_name") HAVING count(*) > 1
  ) AS t;

  SELECT count(*) INTO fba_clashes FROM (
    SELECT 1 FROM "fba_categories"
    GROUP BY lower("name") HAVING count(*) > 1
  ) AS t;

  SELECT count(*) INTO shift_clashes FROM (
    SELECT 1 FROM "shifts"
    GROUP BY lower(btrim("name")) HAVING count(*) > 1
  ) AS t;

  IF expense_clashes + fba_clashes + shift_clashes > 0 THEN
    RAISE EXCEPTION
      'Case-insensitive names: % expense categor(y/ies), % bulk-shipment categor(y/ies) and % shift name(s) are used twice in different case. Rename or merge one of each first; prep/check-case-collisions.sql lists them.',
      expense_clashes, fba_clashes, shift_clashes;
  END IF;
END $$;

-- Shift names were saved untrimmed until now; the application trims from here on.
UPDATE "shifts"
SET "name" = btrim("name")
WHERE "name" <> btrim("name");

CREATE UNIQUE INDEX "uq_expense_categories_name_ci" ON "expense_categories" (lower("category_name"));

CREATE UNIQUE INDEX "uq_fba_categories_name_ci" ON "fba_categories" (lower("name"));

CREATE UNIQUE INDEX "uq_shifts_name_ci" ON "shifts" (lower("name"));
