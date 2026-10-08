ALTER TABLE public.payment_intents
  ADD COLUMN mp_payment_reference_id text,
  ADD COLUMN payer_cuit varchar(11),
  ADD CONSTRAINT payment_intents_payer_cuit_check
    CHECK (payer_cuit IS NULL OR
      (payer_cuit ~ '^[0-9]{11}$' AND mp_payment_reference_id IS NOT NULL));

COMMENT ON COLUMN public.payment_intents.payer_cuit IS
  'CUIT verified against an approved Mercado Pago payment; receiver suggestion only.';
