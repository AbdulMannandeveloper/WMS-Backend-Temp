-- Billing that matches the business: a per-item shipment charge that lives on
-- the rate card, and services that bill without a shipment.
--
-- Three changes, and one deletion that needs justifying.
--
-- 1. services.code — a stable identifier for services the system raises itself,
--    so the dispatch path can find "shipment dispatch" without matching on a
--    description an admin is free to rename. Only SHIPMENT_DISPATCH uses it
--    today; ordinary catalogue rows leave it null.
--
-- 2. clients_services.is_recurring / recurring_quantity — a standing charge,
--    raised every period whether or not anything shipped. A client who takes
--    storage or a retainer but never ships had no automated route to an invoice
--    at all: line items were only ever created at dispatch, so nothing fired.
--
-- 3. LineItemType.RECURRING_SERVICE — so those lines are distinguishable from
--    the ones a shipment produced. Added as a value, not a replacement; nothing
--    in this migration uses it, which is what keeps it legal inside the
--    transaction Prisma wraps around this file.
--
-- 4. clients.fixed_shipment_rate is DROPPED. It was read once, at dispatch, and
--    written nowhere in the entire application: not in updateClient's field
--    allowlist, not by any route (clients has no PUT at all), not by the
--    frontend. Every row therefore held its 0.00 default, and dispatch skips the
--    charge at zero — so no shipment charge was ever raised for any client. The
--    only writes were in test fixtures going direct to Prisma, which is why the
--    suite passed while the feature was unreachable. The rate is a ClientService
--    now, where it can actually be set, has a unit, and appears in the client's
--    service list. Dropping rather than leaving it dead: a column that looks
--    like it controls billing is how someone later sets it and expects an
--    invoice.

-- AlterEnum
ALTER TYPE "LineItemType" ADD VALUE 'RECURRING_SERVICE';

-- AlterTable
ALTER TABLE "clients" DROP COLUMN "fixed_shipment_rate";

-- AlterTable
ALTER TABLE "clients_services" ADD COLUMN     "is_recurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recurring_quantity" DECIMAL(10,2) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "code" VARCHAR(40);

-- CreateIndex
CREATE UNIQUE INDEX "services_code_key" ON "services"("code");
