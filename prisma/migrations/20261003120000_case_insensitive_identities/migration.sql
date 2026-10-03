-- Emails and usernames are matched without regard to letter case, and NI
-- numbers without regard to case or spacing. The application stores each in
-- one spelling (utils/identifiers.js); this brings existing rows into that
-- spelling and makes the database hold the same rule, so a write path that
-- skips the normaliser fails instead of storing a row no lookup will find.

-- Refuse to start rather than guess which of two accounts is the real one.
-- Rows that differ only in case become duplicates once lowercased, and the
-- unique indexes would reject the UPDATE below with a less helpful message.
-- The counts are deliberately all this prints: the values are personal data
-- and would land in the deploy logs. prep/check-case-collisions.sql lists them.
DO $$
DECLARE
  email_clashes integer;
  username_clashes integer;
  ni_clashes integer;
BEGIN
  SELECT count(*) INTO email_clashes FROM (
    SELECT 1 FROM "users" GROUP BY lower(btrim("email")) HAVING count(*) > 1
  ) AS t;

  SELECT count(*) INTO username_clashes FROM (
    SELECT 1 FROM "users"
    WHERE NULLIF(btrim("username"), '') IS NOT NULL
    GROUP BY lower(btrim("username")) HAVING count(*) > 1
  ) AS t;

  SELECT count(*) INTO ni_clashes FROM (
    SELECT 1 FROM "employees"
    WHERE NULLIF(regexp_replace("national_insurance_number", '\s', '', 'g'), '') IS NOT NULL
    GROUP BY upper(regexp_replace("national_insurance_number", '\s', '', 'g')) HAVING count(*) > 1
  ) AS t;

  IF email_clashes + username_clashes + ni_clashes > 0 THEN
    RAISE EXCEPTION
      'Case-insensitive identities: % email(s), % username(s) and % NI number(s) are held by more than one row in different spellings. Resolve them first; prep/check-case-collisions.sql lists them.',
      email_clashes, username_clashes, ni_clashes;
  END IF;
END $$;

UPDATE "users"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));

UPDATE "users"
SET "username" = NULLIF(lower(btrim("username")), '')
WHERE "username" IS DISTINCT FROM NULLIF(lower(btrim("username")), '');

-- The client's contact email is also its login, and the two are edited
-- together. Not unique, so nothing to collide.
UPDATE "clients"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));

UPDATE "employees"
SET "national_insurance_number" = NULLIF(upper(regexp_replace("national_insurance_number", '\s', '', 'g')), '')
WHERE "national_insurance_number" IS DISTINCT FROM NULLIF(upper(regexp_replace("national_insurance_number", '\s', '', 'g')), '');

ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_email_canonical" CHECK ("email" = lower(btrim("email")));

ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_username_canonical" CHECK ("username" = lower(btrim("username")) AND "username" <> '');

ALTER TABLE "employees"
  ADD CONSTRAINT "ck_employees_ni_number_canonical" CHECK (
    "national_insurance_number" = upper(regexp_replace("national_insurance_number", '\s', '', 'g'))
    AND "national_insurance_number" <> ''
  );
