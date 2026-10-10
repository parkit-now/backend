ALTER TABLE invoices
  ADD COLUMN selected_payment_ids uuid[] NOT NULL DEFAULT '{}';
