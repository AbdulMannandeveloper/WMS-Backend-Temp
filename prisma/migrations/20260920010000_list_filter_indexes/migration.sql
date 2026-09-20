-- Columns the list endpoints start filtering and sorting on.
--
-- Three of these tables had no index of any kind before this — audit_logs,
-- employee_fines and employee_bonuses carried a primary key and nothing else.
-- Postgres does not index a foreign-key column for you, so user_id on all three
-- was a sequential scan, and they are among the fastest-growing tables here.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: Prisma runs each migration file
-- inside a transaction, and CONCURRENTLY cannot run in one. At present volumes
-- the write lock is momentary. Should that stop being true, these have to be
-- split out and run outside the migration runner.
--
-- Every list orders by its sort column and then by id, so the indexes are
-- (sort_col DESC, id) — the tiebreaker is part of the ordering, not an
-- afterthought, and an index that stops short of it leaves the sort half-served.

-- ─── audit_logs (no indexes before this) ─────────────────────────────────────
CREATE INDEX "idx_audit_logs_timestamp"        ON "audit_logs" ("timestamp" DESC, "id");
CREATE INDEX "idx_audit_logs_user_timestamp"   ON "audit_logs" ("user_id", "timestamp" DESC);
CREATE INDEX "idx_audit_logs_action_timestamp" ON "audit_logs" ("action", "timestamp" DESC);

-- ─── employee_fines (no indexes before this) ─────────────────────────────────
CREATE INDEX "idx_employee_fines_date"      ON "employee_fines" ("date" DESC, "id");
CREATE INDEX "idx_employee_fines_user_date" ON "employee_fines" ("user_id", "date" DESC);

-- ─── employee_bonuses (no indexes before this) ───────────────────────────────
CREATE INDEX "idx_employee_bonuses_date"      ON "employee_bonuses" ("date" DESC, "id");
CREATE INDEX "idx_employee_bonuses_user_date" ON "employee_bonuses" ("user_id", "date" DESC);

-- ─── shipments ───────────────────────────────────────────────────────────────
-- client+created_at and employee+created_at already exist; a status filter or an
-- unfiltered newest-first list was served by neither.
CREATE INDEX "idx_shipments_created_at"            ON "shipments" ("created_at" DESC, "id");
CREATE INDEX "idx_shipments_status_created_at"     ON "shipments" ("status", "created_at" DESC);
CREATE INDEX "idx_shipments_created_by_created_at" ON "shipments" ("created_by_user_id", "created_at" DESC);

-- ─── monthly_invoices ────────────────────────────────────────────────────────
-- Only client+status existed, so the default billing-period ordering scanned.
CREATE INDEX "idx_monthly_invoices_billing_period"        ON "monthly_invoices" ("billing_period" DESC, "id");
CREATE INDEX "idx_monthly_invoices_status_billing_period" ON "monthly_invoices" ("status", "billing_period" DESC);
CREATE INDEX "idx_monthly_invoices_created_at"            ON "monthly_invoices" ("created_at" DESC);

-- ─── fba_shipments ───────────────────────────────────────────────────────────
CREATE INDEX "idx_fba_shipments_received_at"          ON "fba_shipments" ("received_at" DESC, "id");
CREATE INDEX "idx_fba_shipments_status_received_at"   ON "fba_shipments" ("status", "received_at" DESC);
CREATE INDEX "idx_fba_shipments_category_received_at" ON "fba_shipments" ("category_id", "received_at" DESC);

-- ─── products ────────────────────────────────────────────────────────────────
-- The catalogue is listed by name, and sku_code alone was only ever reachable
-- through the (client_id, sku_code) unique — useless without a client.
CREATE INDEX "idx_products_product_name"        ON "products" ("product_name", "id");
CREATE INDEX "idx_products_client_product_name" ON "products" ("client_id", "product_name");
CREATE INDEX "idx_products_sku_code"            ON "products" ("sku_code");

-- ─── inventory_ledger ────────────────────────────────────────────────────────
-- (product_id, timestamp) existed, which does not serve a global newest-first
-- read — the leading column has to be in the query for a composite to apply.
CREATE INDEX "idx_inventory_ledger_timestamp"          ON "inventory_ledger" ("timestamp" DESC, "id");
CREATE INDEX "idx_inventory_ledger_movement_timestamp" ON "inventory_ledger" ("movement_type", "timestamp" DESC);
CREATE INDEX "idx_inventory_ledger_user_timestamp"     ON "inventory_ledger" ("user_id", "timestamp" DESC);

-- ─── employee_attendance_logs ────────────────────────────────────────────────
-- (user_id, date) existed, so "everyone on this date" — which is the roster,
-- the most-read screen in the module — scanned.
CREATE INDEX "idx_attendance_date"        ON "employee_attendance_logs" ("date" DESC, "id");
CREATE INDEX "idx_attendance_date_status" ON "employee_attendance_logs" ("date", "status");

-- ─── users ───────────────────────────────────────────────────────────────────
-- Drives the attendance roster and the payroll employee list, both of which page
-- users by role and order them by name.
CREATE INDEX "idx_users_role_name" ON "users" ("role", "first_name", "last_name", "id");
CREATE INDEX "idx_users_is_active" ON "users" ("is_active");

-- ─── expenses ────────────────────────────────────────────────────────────────
-- date and (category_id, date) already exist; the amount range filter is new.
CREATE INDEX "idx_expenses_amount" ON "expenses" ("amount");

-- ─── warehouse_locations ─────────────────────────────────────────────────────
CREATE INDEX "idx_warehouse_locations_name" ON "warehouse_locations" ("location_name", "id");

-- ─── monthly_invoices.grand_total ────────────────────────────────────────────
--
-- The invoices screen filters and sorts on Total Due, which is
-- total_amount + tax_amount. That is an expression, and Prisma's query builder
-- cannot filter or order by one — so without a column, the filter has to be
-- applied after the page is read, which makes the total a lie.
--
-- GENERATED ALWAYS rather than a column the application maintains: there are
-- three places that move these figures — recalculateInvoiceTotal, setInvoiceTax
-- (which writes tax_amount directly) and applyInvoiceEdits — and a derived
-- total with three writers is a drift waiting to happen. The database computes
-- it or nothing does.
--
-- NOT NULL is load-bearing, and the reason is not obvious. A generated column
-- is nullable by default, and Prisma emits an explicit NULL for every nullable
-- field it knows about — even one carrying a dbgenerated() default. Postgres
-- refuses any write to a generated column, including that NULL, so declaring it
-- nullable made every INSERT on this table fail:
--
--     cannot insert a non-DEFAULT value into column "grand_total"
--
-- Invoices are created by dispatch, by returns and by billing, so that took 107
-- tests down at once. Marked NOT NULL, Prisma treats the column as
-- database-supplied and leaves it out of the INSERT entirely. Do not relax it.
--
-- Prisma 6 cannot express GENERATED ALWAYS, so schema.prisma models this the
-- closest way it can — NOT NULL with a dbgenerated() default — which reports no
-- drift against a database built from this file. What a fresh `migrate dev`
-- would lose is the generation clause itself; the deploy path runs
-- `migrate deploy` from this file, so the clause is what production gets.
ALTER TABLE "monthly_invoices"
  ADD COLUMN "grand_total" numeric(14,2)
  GENERATED ALWAYS AS ("total_amount" + "tax_amount") STORED NOT NULL;

CREATE INDEX "idx_monthly_invoices_grand_total" ON "monthly_invoices" ("grand_total");
