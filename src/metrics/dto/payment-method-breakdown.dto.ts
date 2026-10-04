import { ApiProperty } from '@nestjs/swagger';

/**
 * Name of the slice (and value of the `paymentMethod` revenue filter) that
 * groups money paid online for reservations. It is its own bucket, never
 * `unallocated`: those payments never went through the till.
 */
export const RESERVATION_PAYMENT_METHOD = 'Mercado Pago (reserva)';

/** One slice of the payment-method pie. */
export class PaymentMethodSliceDto {
  @ApiProperty({
    description:
      'Payment method name, as snapshotted on the transaction. Snapshots are used rather than a join, so methods deleted since the payment still report correctly.',
    example: 'Efectivo',
  })
  name: string;

  @ApiProperty({
    enum: ['payment', 'reservation'],
    description: [
      '`payment`: a till payment method (from `payment_transactions`).',
      '`reservation`: the single slice named `Mercado Pago (reserva)` — reservation prepayments paid online, recognised on an accrual basis (stay exit, no-show date, or cancellation date). Pass that name as the `paymentMethod` filter of the revenue endpoint to get only this money.',
    ].join('\n'),
    example: 'payment',
  })
  kind: 'payment' | 'reservation';

  @ApiProperty({
    type: Number,
    description: 'Total collected, in ARS.',
    example: 12300,
  })
  amount: number;

  @ApiProperty({
    type: 'integer',
    description: 'Transactions recorded for this method.',
    example: 21,
  })
  count: number;

  @ApiProperty({
    type: Number,
    description:
      'Share of `total`, `0`–`1`. Shares across every slice plus `unallocated` add up to 1, so the pie is complete. `null` when `total` is 0.',
    example: 0.42,
  })
  share: number | null;
}

/**
 * Response of `GET /tenants/:tenantId/metrics/revenue/by-payment-method`.
 *
 * Reconciles two tables that can disagree, and says so rather than hiding it.
 */
export class PaymentMethodBreakdownDto {
  @ApiProperty({ format: 'date-time' })
  from: Date;

  @ApiProperty({ format: 'date-time' })
  to: Date;

  @ApiProperty({
    description: 'Currency of every monetary figure.',
    example: 'ARS',
  })
  currency: string;

  @ApiProperty({
    type: Number,
    description:
      'Authoritative revenue for the window: `entries.amountPaid` plus the reservation money (`Mercado Pago (reserva)` slice). This is the figure the KPI shows.',
    example: 29300,
  })
  total: number;

  @ApiProperty({
    type: Number,
    description:
      'Portion of `total` that has itemised transactions behind it, including the reservation slice.',
    example: 25000,
  })
  allocated: number;

  @ApiProperty({
    type: Number,
    description: [
      'Revenue with **no payment-method breakdown**: `total - allocated`.',
      '',
      'Closing a stay accepts a bare `amountPaid` with no `payments[]` (the offline fallback the desktop uses), and that path records no transaction row. Without this field the slices would silently fail to add up to the KPI and the dashboard would look broken. Render it as its own "sin detalle" slice.',
      '',
      'A negative value means transactions exceed the stays’ recorded totals — a data inconsistency worth surfacing, not a rendering bug.',
    ].join('\n'),
    example: 4300,
  })
  unallocated: number;

  @ApiProperty({
    type: [PaymentMethodSliceDto],
    description: 'One slice per payment method, largest first.',
  })
  methods: PaymentMethodSliceDto[];
}
