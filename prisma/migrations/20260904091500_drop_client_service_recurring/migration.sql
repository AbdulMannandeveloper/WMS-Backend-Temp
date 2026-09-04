-- Drop the standing-monthly-charge fields from an agreed rate.
--
-- A client service is a price per unit and nothing more. The recurring flag
-- and its quantity turned the rate card into a billing engine that raised
-- charges from resolveOpenInvoiceFor on every invoice open, which was never
-- the intent.
--
-- Invoice lines already written with item_type = 'RECURRING_SERVICE' are left
-- exactly as they are: they are historical accounting records, they reference
-- client_service_id rather than these columns, and rewriting a client's past
-- invoice to tidy a schema would be the worse mistake. The enum value stays
-- for the same reason.
--
-- Checked before writing this: 0 rows had is_recurring set and 0 invoice lines
-- carried that type.

ALTER TABLE "clients_services" DROP COLUMN IF EXISTS "is_recurring";
ALTER TABLE "clients_services" DROP COLUMN IF EXISTS "recurring_quantity";
