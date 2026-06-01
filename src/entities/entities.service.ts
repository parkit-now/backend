import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { AuditEventDto } from '../audit/dto/audit-event.dto';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { EntityAuditQueryDto } from './dto/entity-audit-query.dto';
import {
  EntityProfileDto,
  PaymentMethodSummaryDto,
} from './dto/entity-profile.dto';
import { TogglePaymentMethodDto } from './dto/toggle-payment-method.dto';
import { UpdateEntityProfileDto } from './dto/update-entity-profile.dto';
import { toEntityProfileDto, toPaymentMethodDto } from './entities.mappers';

/**
 * Manages the entity (tenant) profile, its payment methods and audit trail.
 *
 * `tenants`, `payment_methods` and `audit_log` are GLOBAL tables (not in
 * `TENANT_MODELS`), so this service uses the plain Prisma client filtering by
 * the `:tenantId` from the route (already validated by `TenantMembershipGuard`).
 */
@Injectable()
export class EntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Profile of the entity (tenant) + payment-method summary. */
  async getProfile(tenantId: string): Promise<EntityProfileDto> {
    const tenant = await this.loadTenant(tenantId);
    const paymentMethods = await this.prisma.paymentMethod.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return toEntityProfileDto(tenant, paymentMethods);
  }

  async updateProfile(
    tenantId: string,
    user: User,
    dto: UpdateEntityProfileDto,
  ): Promise<EntityProfileDto> {
    await this.loadTenant(tenantId);

    const data: Prisma.TenantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.legalName !== undefined) data.legalName = dto.legalName;
    if (dto.cuit !== undefined) data.cuit = dto.cuit;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;

    await this.prisma.tenant.update({ where: { id: tenantId }, data });
    await this.audit.record({
      action: AuditActions.ENTITY_PROFILE_UPDATED,
      entityType: 'tenant',
      entityId: tenantId,
      actorUserId: user.id,
      tenantId,
    });
    return this.getProfile(tenantId);
  }

  async listPaymentMethods(
    tenantId: string,
  ): Promise<PaymentMethodSummaryDto[]> {
    await this.loadTenant(tenantId);
    const methods = await this.prisma.paymentMethod.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return methods.map(toPaymentMethodDto);
  }

  async togglePaymentMethod(
    tenantId: string,
    user: User,
    paymentMethodId: string,
    dto: TogglePaymentMethodDto,
  ): Promise<PaymentMethodSummaryDto> {
    const method = await this.prisma.paymentMethod.findFirst({
      where: { id: paymentMethodId, tenantId },
    });
    if (!method) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Payment method ${paymentMethodId} not found in this entity`,
        '/tenants/:tenantId/payment-methods',
        ErrorCodes.PAYMENT_METHOD_NOT_FOUND,
      );
    }

    const data: Prisma.PaymentMethodUpdateInput = {};
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;

    const updated = await this.prisma.$transaction(async (tx) => {
      // A single default per entity: clearing the rest keeps the invariant.
      if (dto.isDefault === true) {
        await tx.paymentMethod.updateMany({
          where: { tenantId, isDefault: true, NOT: { id: paymentMethodId } },
          data: { isDefault: false },
        });
      }
      return tx.paymentMethod.update({
        where: { id: paymentMethodId },
        data,
      });
    });

    await this.audit.record({
      action: AuditActions.PAYMENT_METHOD_TOGGLED,
      entityType: 'payment_method',
      entityId: paymentMethodId,
      actorUserId: user.id,
      tenantId,
      metadata: { enabled: dto.enabled, isDefault: dto.isDefault },
    });
    return toPaymentMethodDto(updated);
  }

  async listAudit(
    tenantId: string,
    query: EntityAuditQueryDto,
  ): Promise<AuditEventDto[]> {
    await this.loadTenant(tenantId);
    return this.audit.listForTenant(tenantId, {
      limit: query.limit,
      severity: query.severity,
    });
  }

  private async loadTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Entity ${tenantId} not found`,
        '/tenants/:tenantId',
        ErrorCodes.ENTITY_NOT_FOUND,
      );
    }
    return tenant;
  }
}
