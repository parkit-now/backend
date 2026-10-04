import { HttpStatus, Injectable } from '@nestjs/common';
import type { Tenant, User } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import {
  addressCreateData,
  addressUpdateData,
  resolveAddressLine,
  toEntityAddressDto,
} from '../../entities/tenant-address';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { FormattedException } from '../../utils/exceptions/http-exception/formatted-exeption';
import { tenantSearchWhere } from '../../utils/search/tenant-search';
import { resolvePagination } from '../../utils/pagination/pagination-query.dto';
import { CreateParkingDto } from './dto/create-parking.dto';
import { ListParkingsQueryDto } from './dto/list-parkings-query.dto';
import { PaginatedParkingsDto } from './dto/paginated-parkings.dto';
import { ParkingDto } from './dto/parking.dto';
import { UpdateParkingDto } from './dto/update-parking.dto';

const INSTANCE = '/admin/parkings';

@Injectable()
export class ParkingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListParkingsQueryDto): Promise<PaginatedParkingsDto> {
    const { page, pageSize, skip, take } = resolvePagination(query);
    const where = tenantSearchWhere(query.search);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.tenant.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return { items: rows.map(toParkingDto), total, page, pageSize };
  }

  async get(id: string): Promise<ParkingDto> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw this.notFound(id);
    }
    return toParkingDto(tenant);
  }

  /**
   * Crea el tenant y nada más. Los tipos de vehículo, el catálogo, los
   * servicios y los métodos de pago del sistema los siembra el trigger
   * `AFTER INSERT ON tenants` (`bootstrap_tenant_defaults()`, migración
   * 20260901013345), que corre dentro de este mismo INSERT.
   *
   * Antes eso se hacía a mano en `applications.approve()` y ESTE camino se lo
   * olvidaba: un estacionamiento dado de alta desde el panel nacía sin
   * servicios y sin métodos de pago. Si hay que agregar un default nuevo, va en
   * el trigger, no acá.
   */
  async create(admin: User, dto: CreateParkingDto): Promise<ParkingDto> {
    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        legalName: dto.legalName ?? null,
        cuit: dto.cuit ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        // `location.formatted` gana sobre el `address` plano (legacy).
        address: resolveAddressLine(dto.address, dto.location),
        ...addressCreateData(dto.location),
        ...(dto.status ? { status: dto.status } : {}),
      },
    });

    await this.audit.record({
      action: AuditActions.PARKING_CREATED,
      entityType: 'tenant',
      entityId: tenant.id,
      actorUserId: admin.id,
      tenantId: tenant.id,
    });

    return toParkingDto(tenant);
  }

  async update(
    admin: User,
    id: string,
    dto: UpdateParkingDto,
  ): Promise<ParkingDto> {
    await this.ensureExists(id);

    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.legalName !== undefined ? { legalName: dto.legalName } : {}),
        ...(dto.cuit !== undefined ? { cuit: dto.cuit } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        // Después del `address` plano: si vienen los dos, gana `formatted`.
        ...(dto.location !== undefined ? addressUpdateData(dto.location) : {}),
        ...(dto.location?.formatted !== undefined
          ? { address: dto.location.formatted }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });

    await this.audit.record({
      action: AuditActions.PARKING_UPDATED,
      entityType: 'tenant',
      entityId: tenant.id,
      actorUserId: admin.id,
      tenantId: tenant.id,
    });

    return toParkingDto(tenant);
  }

  async remove(admin: User, id: string): Promise<void> {
    const tenant = await this.ensureExists(id);

    // FK cascades drop the dependent rows (memberships, rates, entries,
    // payment methods); audit_log.tenant_id is ON DELETE SET NULL, so the audit
    // entry must NOT reference the tenant being removed — keep it as metadata.
    await this.prisma.tenant.delete({ where: { id } });

    await this.audit.record({
      action: AuditActions.PARKING_DELETED,
      entityType: 'tenant',
      entityId: id,
      actorUserId: admin.id,
      metadata: { name: tenant.name },
    });
  }

  private async ensureExists(id: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw this.notFound(id);
    }
    return tenant;
  }

  private notFound(id: string): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      `Parking ${id} not found`,
      INSTANCE,
      ErrorCodes.PARKING_NOT_FOUND,
    );
  }
}

/** Maps a `Tenant` row to the public `ParkingDto` (drops internal `settings`). */
function toParkingDto(tenant: Tenant): ParkingDto {
  return {
    id: tenant.id,
    name: tenant.name,
    legalName: tenant.legalName,
    cuit: tenant.cuit,
    email: tenant.email,
    phone: tenant.phone,
    address: tenant.address,
    location: toEntityAddressDto(tenant),
    status: tenant.status,
    createdAt: tenant.createdAt,
  };
}
