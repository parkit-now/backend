import { HttpStatus, Injectable } from '@nestjs/common';
import { MpAccountStatus, PaymentMethodType } from '@prisma/client';
import type { Prisma, User } from '@prisma/client';
import { PaginatedAuditDto } from '../audit/dto/paginated-audit.dto';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { resolvePagination } from '../utils/pagination/pagination-query.dto';
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
import {
  readCapacity,
  withDesktopCameraConfig,
  withCapacity,
  withTicketTemplate,
} from './entity-settings';
import { addressUpdateData } from './tenant-address';

/**
 * Un medio de pago que NO existe por sí solo: atrás hay una integración externa
 * que tiene que estar vinculada y viva para que el cobro pueda ocurrir.
 *
 * POR QUÉ ESTO ES UN MAPA Y NO UNA LISTA DE TIPOS
 *
 * Porque un tipo listado sin su chequeo al lado sería un agujero silencioso: el
 * medio quedaría "integrado" para la guarda y aun así se podría prender. Cada
 * entrada trae su propia verificación, así que sumar el segundo tipo es agregar
 * UNA entrada acá y nada más — no hay que tocar `togglePaymentMethod`.
 *
 * Hoy hay uno solo: `mercadopago_qr`, que nace al vincular la cuenta
 * (`MpAccountsService.link`) y se apaga al desvincularla
 * (`MpAccountsService.unlink`). Sin esta guarda, el dueño lo volvía a prender
 * por API sin cuenta vinculada, el operario lo veía en el modal de egreso y no
 * había con qué cobrar.
 *
 * OJO CON EL AISLAMIENTO POR TENANT: `MpAccount` NO está en `TENANT_MODELS`
 * (`src/database/prisma-tenant.ts`), así que la extensión de Prisma NO le
 * inyecta el `WHERE tenant_id`. El filtro va EXPLÍCITO en el `where`, a mano,
 * con el `:tenantId` de la ruta que el `TenantMembershipGuard` ya validó. Mismo
 * patrón que `LprImageRetentionService` y que documenta la cabecera de
 * `prisma/schema/global/mercado-pago.prisma`. Olvidarse de ese filtro acá es
 * una fuga entre playas, sin red abajo.
 */
const INTEGRATION_BACKED_TYPES: Partial<
  Record<
    PaymentMethodType,
    (prisma: PrismaService, tenantId: string) => Promise<boolean>
  >
> = {
  [PaymentMethodType.mercadopago_qr]: async (prisma, tenantId) => {
    const account = await prisma.mpAccount.findUnique({
      // `tenantId` EXPLÍCITO: es todo el aislamiento que hay para este modelo.
      where: { tenantId },
      select: { status: true },
    });
    // `token_expired` y `revoked` tampoco cobran: sólo `linked` sirve.
    return account?.status === MpAccountStatus.linked;
  },
};

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
    if (dto.lprImageRetentionDays !== undefined) {
      data.lprImageRetentionDays = dto.lprImageRetentionDays;
    }
    // `null` explícito = desvincular la cámara. Por eso se compara contra
    // undefined y no se usa un truthy check: `?? null` borraría el valor cada
    // vez que el cliente manda el resto del perfil sin tocar la cámara.
    if (dto.entryCameraId !== undefined) {
      data.entryCameraId = dto.entryCameraId;
    }
    if (dto.entryCameraLabel !== undefined) {
      data.entryCameraLabel = dto.entryCameraLabel;
    }

    // Dirección estructurada: columnas planas de `tenants`, no `settings`.
    // `location.formatted` se aplica DESPUÉS del `address` plano a propósito:
    // el plano es el contrato viejo, `formatted` trae la `nomenclatura`
    // normalizada. Si el cliente manda los dos distintos, gana el nuevo.
    if (dto.location !== undefined) {
      Object.assign(data, addressUpdateData(dto.location));
      if (dto.location.formatted !== undefined) {
        data.address = dto.location.formatted;
      }
    }

    let nextSettings: Prisma.InputJsonValue =
      tenant.settings as Prisma.InputJsonValue;
    let settingsChanged = false;

    // Capacity lives in `settings.capacity`; merge so an omitted `total` keeps
    // the current value instead of resetting the lot to zero.
    if (dto.capacity !== undefined) {
      const current = readCapacity(tenant.settings);
      nextSettings = withCapacity(nextSettings as Prisma.JsonValue, {
        total: dto.capacity.total ?? current.total,
      });
      settingsChanged = true;
    }
    if (dto.ticketTemplate !== undefined) {
      nextSettings = withTicketTemplate(
        nextSettings as Prisma.JsonValue,
        dto.ticketTemplate,
      );
      settingsChanged = true;
    }
    if (dto.desktopCameraConfig !== undefined) {
      nextSettings = withDesktopCameraConfig(nextSettings as Prisma.JsonValue, {
        ...dto.desktopCameraConfig,
        tuning: dto.desktopCameraConfig.tuning ?? null,
      });
      settingsChanged = true;
    }
    if (settingsChanged) data.settings = nextSettings;

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
    if (method.isSystem) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Payment method ${paymentMethodId} is a system method and cannot be deleted; disable it instead`,
        '/tenants/:tenantId/payment-methods',
        ErrorCodes.PAYMENT_METHOD_SYSTEM_LOCKED,
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

    // Las DOS acciones que ponen el medio EN CIRCULACIÓN piden la cuenta viva:
    // prenderlo lo devuelve a la pantalla de cobro, y marcarlo predeterminado
    // lo deja PRESELECCIONADO en el modal de egreso. Marcar como default no es
    // neutral respecto de la disponibilidad: es el que el operario se
    // encuentra puesto. Sin esto, un QR muerto vuelve a la caja por la puerta
    // del `isDefault`.
    //
    // Siempre permitido, con cuenta o sin ella: renombrar (es cosmético),
    // `enabled: false` y `isDefault: false`. Apagarlo sin la cuenta vinculada
    // es JUSTO la salida de emergencia del dueño para sacar el medio muerto de
    // la pantalla de cobro; bloquearlo lo dejaría encerrado con el QR roto.
    const requiresLinkedIntegration = INTEGRATION_BACKED_TYPES[method.type];
    // Se resuelve UNA sola vez aunque el DTO traiga las dos banderas prendidas:
    // el chequeo es una query, no se paga dos veces por el mismo PATCH.
    const rejectedAction =
      dto.enabled === true
        ? 'enabling it'
        : dto.isDefault === true
          ? 'making it the default'
          : null;
    if (rejectedAction && requiresLinkedIntegration) {
      const linked = await requiresLinkedIntegration(this.prisma, tenantId);
      if (!linked) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `Payment method ${paymentMethodId} is backed by the ${method.type} integration, which is not linked for this entity; link the account again from Integrations before ${rejectedAction}`,
          '/tenants/:tenantId/payment-methods',
          ErrorCodes.PAYMENT_METHOD_INTEGRATION_NOT_LINKED,
        );
      }
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
  ): Promise<PaginatedAuditDto> {
    await this.loadTenant(tenantId);

    const { page, pageSize, skip, take } = resolvePagination(query);
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    if (from && to && from >= to) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        '`from` must be earlier than `to`.',
        `/tenants/${tenantId}/audit`,
        ErrorCodes.VALIDATION_FAILED,
      );
    }

    const { items, total } = await this.audit.listForTenant(tenantId, {
      severity: query.severity,
      action: query.action,
      from,
      to,
      skip,
      take,
    });

    return { items, page, pageSize, total };
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
