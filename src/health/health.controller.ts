import { Controller, Get, Res } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { HealthCheckItemDto, HealthResponseDto } from './dto/health.dto';

const DB_CHECK_TIMEOUT_MS = 2_000;

@ApiTags('Health')
@ApiExtraModels(HealthCheckItemDto, HealthResponseDto)
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    operationId: 'healthCheck',
    summary: 'Liveness + readiness probe with dependency status',
    description: [
      'Aggregated health probe used by orchestrators (Docker, Kubernetes, load balancers) ' +
        'and uptime monitors. Pings every external dependency and reports a single status.',
      '',
      '**Behavior:**',
      '- Runs `SELECT 1` against PostgreSQL through Prisma, with a 2 s timeout per check.',
      '- Returns `200 OK` when every entry under `checks` is `up`.',
      '- Returns `503 Service Unavailable` when at least one check is `down`. The response body keeps the same shape, so callers do not need to branch on the HTTP status to read the result.',
      '- The endpoint never throws; failures are reported in the body, not as a 5xx Problem Details.',
      '',
      '**Auth required:** none (public endpoint, safe to expose to probes).',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: 'All dependencies are reachable.',
    type: HealthResponseDto,
    schema: {
      example: {
        status: 'ok',
        uptime: 1234.56,
        timestamp: '2026-05-04T12:34:56.789Z',
        checks: {
          database: { status: 'up', latencyMs: 4 },
        },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description:
      'At least one dependency is unreachable. Inspect `checks` to see which one.',
    type: HealthResponseDto,
    schema: {
      example: {
        status: 'error',
        uptime: 1234.56,
        timestamp: '2026-05-04T12:34:56.789Z',
        checks: {
          database: {
            status: 'down',
            latencyMs: 2000,
            error: 'connect ECONNREFUSED 127.0.0.1:5432',
          },
        },
      },
    },
  })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    const database = await this.checkDatabase();
    const healthy = database.status === 'up';

    res.status(healthy ? 200 : 503);

    return {
      status: healthy ? 'ok' : 'error',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }

  private async checkDatabase(): Promise<HealthCheckItemDto> {
    const startedAt = Date.now();
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Database check timed out after ${DB_CHECK_TIMEOUT_MS} ms`,
                ),
              ),
            DB_CHECK_TIMEOUT_MS,
          ),
        ),
      ]);
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
