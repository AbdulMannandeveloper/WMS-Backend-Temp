-- Returning goods after dispatch.
--
-- returned_quantity is per line rather than a separate table: a return is a
-- correction to what went out, and capping at (quantity - returned_quantity)
-- is what stops the same ten units being returned twice.
--
-- RETURN is its own movement type rather than reusing CHECKIN. Goods coming
-- back from a customer and goods arriving from a supplier are different
-- events, and folding them together would make every inbound report wrong.
--
-- Nothing here touches billing. A return does not amend, reverse or add an
-- invoice line: the dispatch happened and was charged for.

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'RETURN';

-- AlterTable
ALTER TABLE "shipment_items" ADD COLUMN     "returned_quantity" INTEGER NOT NULL DEFAULT 0;
