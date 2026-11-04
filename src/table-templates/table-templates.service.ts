import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import {
  TableTemplateQueryDto,
  SaveTableTemplateDto,
  TableTemplateDto,
} from './table-templates.dto';

// Global personal preferences. Every query scopes BOTH the authenticated owner and context.
// Tenant context is resolved by TenantInterceptor; the admin controller uses a fixed context.
@Injectable()
export class TableTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private scope(userId: string, query: TableTemplateQueryDto, admin: boolean) {
    return {
      userId,
      platform: query.platform,
      tableKey: query.tableKey,
      contextKey: admin
        ? 'admin'
        : this.tenantContext.getTenantIdOrThrow().toLowerCase(),
    };
  }
  async list(
    userId: string,
    query: TableTemplateQueryDto,
    admin = false,
  ): Promise<TableTemplateDto[]> {
    const rows = await this.prisma.userTableTemplate.findMany({
      where: this.scope(userId, query, admin),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.dto(row));
  }

  async mutate(
    userId: string,
    query: TableTemplateQueryDto,
    id: string,
    mutationId: string,
    body?: SaveTableTemplateDto,
    importOnly = false,
    admin = false,
  ): Promise<TableTemplateDto> {
    const scope = this.scope(userId, query, admin);
    const key = { ...scope, id };
    const where = { userId_platform_contextKey_tableKey_id: key };
    const target = JSON.stringify([
      scope.platform,
      scope.contextKey,
      scope.tableKey,
      id,
      body ? (importOnly ? 'import' : 'save') : 'delete',
    ]);
    return this.prisma.$transaction(async (tx) => {
      // Serialize mutations per owner, including retries on different devices.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
      const receipt = await tx.userTableTemplateMutation.findUnique({
        where: { userId_mutationId: { userId, mutationId } },
      });
      if (receipt && receipt.target !== target) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'Mutation identifier already used',
          '/table-templates',
          ErrorCodes.CONFLICT,
        );
      }
      if (!receipt) {
        const now = new Date();
        const data = body
          ? {
              name: body.name.trim(),
              description: body.description?.trim() || null,
              config: body.config as Prisma.InputJsonObject,
              updatedAt: now,
              deletedAt: null,
            }
          : {
              name: '',
              config: {} as Prisma.InputJsonObject,
              updatedAt: now,
              deletedAt: now,
            };
        const existing = await tx.userTableTemplate.findUnique({ where });
        if (!importOnly || !existing) {
          await tx.userTableTemplate.upsert({
            where,
            create: {
              ...key,
              ...data,
              createdAt:
                importOnly && body?.createdAt ? new Date(body.createdAt) : now,
            },
            update: body ? data : { updatedAt: now, deletedAt: now },
          });
        }
        await tx.userTableTemplateMutation.create({
          data: { userId, mutationId, target },
        });
      }
      const row = await tx.userTableTemplate.findUniqueOrThrow({ where });
      return this.dto(row);
    });
  }
  private dto(row: {
    id: string;
    name: string;
    description: string | null;
    config: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): TableTemplateDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      config: row.config as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    };
  }
}
