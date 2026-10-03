import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IsOffsetDateTime } from '../../utils/validators/is-offset-date-time';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import {
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../../vehicle-categories/vehicle-categories';
import { MetricsTzQueryDto } from './metrics-tz-query.dto';

/** `from`/`to` are required, unless a cash session supplies the window. */
const windowBoundRequired =
  (bound: 'from' | 'to') =>
  (query: MetricsWindowQueryDto): boolean =>
    !query.cashSessionId || query[bound] !== undefined;

/**
 * The time window every analytical metrics endpoint takes, plus the filters
 * they all share.
 *
 * `from`/`to` describe a **continuous interval**, not a daily recurring
 * window: `2026-08-07T13:00-03:00` → `2026-08-18T03:00-03:00` is one stretch
 * covering every night in between.
 *
 * `tz` is inherited so clients can send the same query object everywhere —
 * the global pipe runs with `forbidNonWhitelisted`, so an undeclared parameter
 * is a 400. It only changes behaviour where results are bucketed by calendar.
 */
export class MetricsWindowQueryDto extends MetricsTzQueryDto {
  @ApiPropertyOptional({
    description: [
      'Start of the window (inclusive), ISO-8601 **with an explicit offset**.',
      '',
      '**Required unless `cashSessionId` is given**, in which case it defaults to the start of the shift — see `cashSessionId`.',
      '',
      'The offset is mandatory: a naive `2026-08-07T13:00:00` would be resolved against the server clock, silently shifting the numbers by the Argentine offset. Send `-03:00` for Argentine wall-clock time.',
    ].join('\n'),
    example: '2026-08-07T13:00:00-03:00',
  })
  // `@ValidateIf` rather than `@IsOptional`: without a session the bound is
  // still mandatory, and `@IsOffsetDateTime` rejects `undefined` on its own.
  @ValidateIf(windowBoundRequired('from'))
  @IsOffsetDateTime()
  from?: string;

  @ApiPropertyOptional({
    description:
      'End of the window (exclusive), ISO-8601 with explicit offset. **Required unless `cashSessionId` is given.**',
    example: '2026-08-18T03:00:00-03:00',
  })
  @ValidateIf(windowBoundRequired('to'))
  @IsOffsetDateTime()
  to?: string;

  @ApiPropertyOptional({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    description: [
      'Restrict to a platform vehicle category, matched against `entries.vehicleCategory`.',
      '',
      '`entries.vehicleCategory` is frozen at ingress, so changing the category of a vehicle type does not rewrite history. It is filled on manual and LPR stays alike; stays that predate the categories (or came from an old till) have none and are excluded by this filter.',
      '',
      'Can be combined with the deprecated `vehicleType`: both must match.',
    ].join('\n'),
    example: 'suv',
  })
  @IsOptional()
  @IsIn(VEHICLE_CATEGORIES)
  vehicleCategory?: VehicleCategory;

  @ApiPropertyOptional({
    deprecated: true,
    maxLength: 60,
    description: [
      '**Deprecated: use `vehicleCategory`.** It will be removed in the next version.',
      '',
      'Restrict to a vehicle type, matched **exactly** against `entries.vehicleType`, the text snapshot of the type name taken at ingress. Renaming a type does not rewrite history — stays registered under the old name keep answering to the old name, and two types with different names never group together, which is why the category replaces this.',
    ].join('\n'),
    example: 'Auto',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  vehicleType?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: [
      'Restrict to what one cash session (shift) **collected** — the figures for a cash-up.',
      '',
      'Matches `payment_transactions.cashSessionId`: the drawer that took the money when the stay was closed. **Not** `entries.cashSessionId`, which records the drawer a car *entered* under and is reassigned to the next shift for every car still inside when a shift closes.',
      '',
      'With it, `from`/`to` become optional. A bound you send is used verbatim; a missing one is derived from the shift (`openedAt` → `closedAt`, or now if still open), **widened to cover every payment the shift collected**: the offline desktop can sync a close late with a `leftAt` outside its own shift, and clipping to the shift would drop it. The window actually used comes back in the response `from`/`to`.',
      '',
      'Revenue then comes from the transactions, as with `paymentMethod` (reported in `revenueSource`), and the bucket limit applies to the derived window like to any other — prefer `granularity=hour` for a shift.',
      '',
      '`404 CASH_SESSION_NOT_FOUND` when the session does not exist in this parking lot.',
    ].join('\n'),
  })
  @IsOptional()
  @IsUUID()
  cashSessionId?: string;
}
