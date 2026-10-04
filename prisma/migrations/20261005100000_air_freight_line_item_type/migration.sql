-- The air freight charge line type, added on its own ahead of the migration
-- that uses it.
--
-- Postgres will not let a freshly added enum value be referenced in the same
-- transaction it is added in, and Prisma runs each migration file in one
-- transaction. Splitting the ADD VALUE out means a later migration — and the
-- billing code — can write lines of this type.
ALTER TYPE "LineItemType" ADD VALUE IF NOT EXISTS 'AIR_FREIGHT_CHARGE';
