-- A return booked from a shipment line is linked by the line, not by a scanned
-- label, and the shipment may never have had a tracking number.
ALTER TABLE "product_returns" ALTER COLUMN "tracking_number" DROP NOT NULL;
