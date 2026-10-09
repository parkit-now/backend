ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS manual_invoice_type VARCHAR(1),
  ADD COLUMN IF NOT EXISTS manual_invoice_point_of_sale VARCHAR(5);
