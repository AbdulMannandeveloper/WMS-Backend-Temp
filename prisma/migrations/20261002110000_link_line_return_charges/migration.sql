-- Link the charges the shipment line return button has already raised to their
-- shipment, so undoing a shipment's line returns takes them off too. The
-- button has always described them as
-- "Return handling — <n> item(s) from shipment <reference>", on the shipment's
-- own client's invoice. Data only; the column already exists.
UPDATE "invoice_line_items" AS l
SET "shipment_id" = s."id"
FROM "shipments" AS s, "monthly_invoices" AS inv
WHERE inv."id" = l."invoice_id"
  AND inv."client_id" = s."client_id"
  AND l."shipment_id" IS NULL
  AND l."item_type" = 'MANUAL_CHARGE'
  AND l."description" LIKE 'Return handling — % item(s) from shipment ' || s."reference";
