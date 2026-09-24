-- New statuses for the three-step bulk flow. RECEIVED stays for legacy rows.
--
-- On its own, ahead of the migration that uses them: Postgres will not let a
-- freshly added enum value be referenced (e.g. as a column default) in the same
-- transaction it is added in, and Prisma runs each migration file in one
-- transaction. Splitting the ADD VALUEs out means the next migration can set the
-- status default to DRAFT.
ALTER TYPE "FbaShipmentStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "FbaShipmentStatus" ADD VALUE IF NOT EXISTS 'PREPARING';
