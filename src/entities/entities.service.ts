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
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { PaymentMethodChangesQueryDto } from './dto/payment-method-changes-query.dto';
import { PaymentMethodChangesResponseDto } from './dto/payment-method-changes-response.dto';
import { TogglePaymentMethodDto } from './dto/toggle-payment-method.dto';
import { UpdateEntityProfileDto } from './dto/update-entity-profile.dto';
import { toEntityProfileDto, toPaymentMethodDto } from './entities.mappers';
import { readCapacity, withCapacity } from './entity-settings';

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
    const tenant = await this.loadTenant(tenantId);

    const data: Prisma.TenantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.legalName !== undefined) data.legalName = dto.legalName;
    if (dto.cuit !== undefined) data.cuit = dto.cuit;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.status !== undefined) data.status = dto.status;

    // Capacity lives in `settings.capacity`; merge so only the supplied
    // vehicle types change and the rest keep their current value.
    if (dto.capacity !== undefined) {
      const current = readCapacity(tenant.settings);
      data.settings = withCapacity(tenant.settings, {
        carSpots: dto.capacity.carSpots ?? current.carSpots,
        motorcycleSpots:
          dto.capacity.motorcycleSpots ?? current.motorcycleSpots,
        bicycleSpots: dto.capacity.bicycleSpots ?? current.bicycleSpots,
      });
    }

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

  async pullPaymentMethodChanges(
    tenantId: string,
    query: PaymentMethodChangesQueryDto,
  ): Promise<PaymentMethodChangesResponseDto> {
    const items = await this.prisma.paymentMethod.findMany({
      where: { tenantId, syncSeq: { gt: query.afterSeq } },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toPaymentMethodDto), maxSeq };
  }

  async createPaymentMethod(
    tenantId: string,
    user: User,
    dto: CreatePaymentMethodDto,
  ): Promise<PaymentMethodSummaryDto> {
    const method = await this.prisma.paymentMethod.create({
      data: {
        tenantId,
        name: dto.name,
        type: 'other',
      },
    });
    await this.audit.record({
      action: AuditActions.PAYMENT_METHOD_TOGGLED,
      entityType: 'payment_method',
      entityId: method.id,
      actorUserId: user.id,
      tenantId,
      metadata: { action: 'created', name: dto.name },
    });
    return toPaymentMethodDto(method);
  }

  async deletePaymentMethod(
    tenantId: string,
    user: User,
    paymentMethodId: string,
  ): Promise<void> {
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
    await this.prisma.paymentMethod.delete({ where: { id: paymentMethodId } });
    await this.audit.record({
      action: AuditActions.PAYMENT_METHOD_TOGGLED,
      entityType: 'payment_method',
      entityId: paymentMethodId,
      actorUserId: user.id,
      tenantId,
      metadata: { action: 'deleted', name: method.name },
    });
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
    if (dto.name !== undefined) data.name = dto.name;
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
