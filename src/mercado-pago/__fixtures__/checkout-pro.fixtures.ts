/**
 * Respuestas de Checkout Pro tal como las documenta Mercado Pago (referencia de
 * `POST /checkout/preferences`, `GET /v1/payments/{id}`, `GET /v1/payments/search`
 * y `POST /v1/payments/{id}/refunds`), recortadas a lo que lee el cliente.
 *
 * TODO(prod-check): son fixtures de la documentación, no capturas reales. En la
 * prueba con plata real hay que compararlas contra una respuesta de verdad.
 */

export const RESERVATION_ID = '0199c2a0-7f3b-7c1d-9e2a-3f4b5c6d7e8f';

export const preferenceCreated = {
  id: '202809963-920c288b-4ebb-40be-966f-700250fa5370',
  init_point:
    'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=202809963-920c288b-4ebb-40be-966f-700250fa5370',
  sandbox_init_point:
    'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=202809963-920c288b-4ebb-40be-966f-700250fa5370',
  external_reference: RESERVATION_ID,
};

const paymentBase = {
  id: 1234567890,
  external_reference: RESERVATION_ID,
  transaction_amount: 1500,
  transaction_amount_refunded: 0,
  collector_id: 446566691,
  currency_id: 'ARS',
};

export const paymentApproved = {
  ...paymentBase,
  status: 'approved',
  status_detail: 'accredited',
};

export const paymentPartiallyRefunded = {
  ...paymentBase,
  status: 'approved',
  status_detail: 'partially_refunded',
  transaction_amount_refunded: 750,
};

export const paymentRefunded = {
  ...paymentBase,
  status: 'refunded',
  status_detail: 'refunded',
  transaction_amount_refunded: 1500,
};

export const paymentRejected = {
  ...paymentBase,
  status: 'rejected',
  status_detail: 'cc_rejected_insufficient_amount',
};

export const paymentCancelled = {
  ...paymentBase,
  status: 'cancelled',
  status_detail: 'by_collector',
};

export const paymentPending = {
  ...paymentBase,
  status: 'pending',
  status_detail: 'pending_waiting_payment',
};

export const paymentInProcess = {
  ...paymentBase,
  status: 'in_process',
  status_detail: 'pending_contingency',
};

export const paymentsSearch = {
  paging: { total: 2, limit: 30, offset: 0 },
  results: [paymentApproved, { ...paymentRejected, id: 1234567001 }],
};

export const refundTotal = {
  id: 987654321,
  payment_id: 1234567890,
  amount: 1500,
  status: 'approved',
  source: { id: '446566691', type: 'collector' },
};
