-- Drop the Mercado Pago branding from the bank-transfer payment method type.
-- Renames the enum value `mp_transfer` -> `transfer`. Existing rows keep their
-- value automatically (an enum label rename is metadata-only).
ALTER TYPE payment_method_type RENAME VALUE 'mp_transfer' TO 'transfer';
