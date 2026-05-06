import { ApiProperty } from '@nestjs/swagger';

/**
 * Status of a single dependency check.
 *
 * `status: 'up'` means the dependency responded within the timeout.
 * `status: 'down'` means the check threw or timed out; `error` carries a short
 * human-readable cause (never a stack trace, never sensitive data).
 */
export class HealthCheckItemDto {
  @ApiProperty({
    description: 'Outcome of the check.',
    enum: ['up', 'down'],
    example: 'up',
  })
  status: 'up' | 'down';

  @ApiProperty({
    description: 'Round-trip latency of the check, in milliseconds.',
    example: 4,
    type: 'integer',
  })
  latencyMs: number;

  @ApiProperty({
    description:
      'Short human-readable error message. Present only when `status` is `down`. ' +
      'Never includes stack traces, credentials or query payloads.',
    example: 'connect ECONNREFUSED 127.0.0.1:5432',
    required: false,
  })
  error?: string;
}

/**
 * Aggregate health response for `GET /health`.
 *
 * Shape is intentionally NOT RFC 7807 — health endpoints follow the
 * de-facto industry convention (k8s, AWS ELB, Cloud Run, etc.) where a
 * monitoring system polls a stable JSON object regardless of HTTP status.
 *
 * HTTP semantics:
 * - `200 OK` when every check is `up`.
 * - `503 Service Unavailable` when at least one check is `down`. The body
 *   keeps the same shape so the caller does not need to branch on status.
 */
export class HealthResponseDto {
  @ApiProperty({
    description:
      'Overall status. `ok` if every entry under `checks` is `up`, ' +
      '`error` if at least one check is `down`.',
    enum: ['ok', 'error'],
    example: 'ok',
  })
  status: 'ok' | 'error';

  @ApiProperty({
    description:
      'Process uptime in seconds (resets on each container restart).',
    example: 1234.56,
  })
  uptime: number;

  @ApiProperty({
    description:
      'Server-side ISO-8601 UTC timestamp at which the check was evaluated.',
    example: '2026-05-04T12:34:56.789Z',
    format: 'date-time',
  })
  timestamp: string;

  @ApiProperty({
    description:
      'Per-dependency results. Currently only `database` (PostgreSQL via Prisma) is checked. ' +
      'New dependencies can be added here without breaking clients.',
    example: {
      database: { status: 'up', latencyMs: 4 },
    },
    additionalProperties: { $ref: '#/components/schemas/HealthCheckItemDto' },
  })
  checks: Record<string, HealthCheckItemDto>;
}
