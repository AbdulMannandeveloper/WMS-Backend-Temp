-- Stock written off the shelf with no shipment behind it.
--
-- CHECKOUT requires a referenceId that resolves to a DISPATCHED shipment, so
-- until now the only way to record damage, loss or a miscount was to invent a
-- dispatch. ADJUSTMENT is the honest movement for that: it leaves a bin, names
-- no shipment, and requires a reason in `notes`.
--
-- Added at the end of the enum. Postgres appends new labels with a new sort
-- position, and nothing orders on this type, so existing rows are untouched.
ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';
