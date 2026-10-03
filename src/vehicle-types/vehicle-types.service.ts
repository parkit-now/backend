import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, VehicleType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCode, ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateVehicleTypeDto } from './dto/create-vehicle-type.dto';
import { DeleteVehicleTypeResultDto } from './dto/delete-vehicle-type.dto';
import { UpdateVehicleTypeDto } from './dto/update-vehicle-type.dto';
import {
  VehicleTypeChangesQueryDto,
  VehicleTypeChangesResponseDto,
} from './dto/vehicle-type-changes.dto';
import { VehicleTypeDto, VehicleTypeListItemDto } from './dto/vehicle-type.dto';
import {
  inferCategoryFromName,
  isVehicleCategory,
  type VehicleCategory,
} from '../vehicle-categories/vehicle-categories';

function toDto(t: VehicleType): VehicleTypeDto {
  return {
    id: t.id,
    tenantId: t.tenantId,
    name: t.name,
    accepted: t.accepted,
    // La columna es varchar con FK a `vehicle_categories`: el valor siempre es
    // uno de la lista, pero si una migración agrega una categoría y el código
    // viejo la lee, cae a `other` en vez de romper el listado.
    category: isVehicleCategory(t.category) ? t.category : 'other',
    categoryInferred: t.categoryInferred,
    version: t.version,
    syncSeq: t.syncSeq,
    deletedAt: t.deletedAt ? t.deletedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * ABM de los tipos de vehículo de un estacionamiento.
 *
 * Antes esto era el enum `vehicle_type` de Postgres: la plataforma decidía las
 * categorías y el dueño las padecía. Ahora cada cuenta nace con ocho propias y
 * editables, y agrega las que necesite. Cada tipo cuelga de una categoría de la
 * plataforma (`vehicle_categories`); el nombre es sólo la etiqueta.
 */
@Injectable()
export class VehicleTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Listado del ABM, con el conteo de vehículos por tipo.
   *
   * El conteo va acá y NO en el feed de sync: es un derivado que envejece, y el
   * desktop hace `bulkPut` de lo que recibe. Sirve para que el modal de borrado
   * sepa de antemano si tiene que pedir un tipo destino.
   */
  async listVehicleTypes(): Promise<VehicleTypeListItemDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();

    const [types, counts] = await Promise.all([
      tenantPrisma.vehicleType.findMany({
        where: { deletedAt: null },
        orderBy: [{ name: 'asc' }],
      }),
      tenantPrisma.vehicle.groupBy({
        by: ['typeId'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const byType = new Map(counts.map((c) => [c.typeId, c._count._all]));
    return types.map((t) => ({
      ...toDto(t),
      vehicleCount: byType.get(t.id) ?? 0,
    }));
  }

  /**
   * Feed de sincronización incremental.
   *
   * Deliberadamente NO filtra `deletedAt`: mandar las filas borradas con su
   * `deletedAt` no-nulo es cómo una baja llega a los clientes offline.
   */
  async pullChanges(
    query: VehicleTypeChangesQueryDto,
  ): Promise<VehicleTypeChangesResponseDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.vehicleType.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async createVehicleType(data: CreateVehicleTypeDto): Promise<VehicleTypeDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    // Una caja vieja crea tipos sin categoría (incluso sin conexión, desde sus
    // operaciones pendientes). No se rechaza: se infiere por el nombre y, si no
    // se reconoce, `other`, y se marca como inferida para que el dueño la revise.
    const category: VehicleCategory =
      data.category ?? inferCategoryFromName(data.name) ?? 'other';

    try {
      const created = await tenantPrisma.vehicleType.create({
        data: {
          id: data.id,
          name: data.name,
          accepted: data.accepted ?? true,
          category,
          categoryInferred: data.category === undefined,
          tenantId,
        },
      });
      return toDto(created);
    } catch (error) {
      throw this.mapUniqueViolation(error, tenantId, data.name);
    }
  }

  async updateVehicleType(
    typeId: string,
    expectedVersion: number,
    data: UpdateVehicleTypeDto,
  ): Promise<VehicleTypeDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    // `version: { increment: 1 }` NO es redundante acá: el trigger
    // `set_vehicle_types_sync_fields` copia el de rates y sólo toca updated_at
    // y sync_seq. La app es lo único que bumpea la versión.
    const updateData: Prisma.VehicleTypeUncheckedUpdateManyInput = {
      version: { increment: 1 },
    };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.accepted !== undefined) updateData.accepted = data.accepted;
    // Guardar la categoría es la confirmación del dueño: apaga "Revisá".
    if (data.category !== undefined) {
      updateData.category = data.category;
      updateData.categoryInferred = false;
    }

    let result: { count: number };
    try {
      result = await tenantPrisma.vehicleType.updateMany({
        where: {
          id: typeId,
          tenantId,
          version: expectedVersion,
          deletedAt: null,
        },
        data: updateData,
      });
    } catch (error) {
      throw this.mapUniqueViolation(error, tenantId, data.name ?? '');
    }

    if (result.count === 0) {
      this.throwWriteFailure(
        typeId,
        tenantId,
        await tenantPrisma.vehicleType.findFirst({ where: { id: typeId } }),
      );
    }

    return toDto(
      await tenantPrisma.vehicleType.findUniqueOrThrow({
        where: { id: typeId },
      }),
    );
  }

  /**
   * Borrado LÓGICO con reasignación obligatoria de los vehículos afectados.
   *
   * ORDEN DENTRO DE LA TRANSACCIÓN, y por qué:
   *
   *   1. Validar el tipo destino (si vino).
   *   2. CAS del tipo (soft delete). PRIMERO a propósito: el conflicto de
   *      versión es el caso frecuente, y así no se escriben —y revierten— N
   *      filas de `vehicles` al pedo.
   *   3. Contar los vehículos que lo usan.
   *   4. Si hay y no vino destino -> 409, que revierte el soft delete.
   *   5. Reasignar.
   *
   * Cada fila reasignada dispara `set_vehicles_sync_fields` (BEFORE UPDATE FOR
   * EACH ROW), así que recibe su propio `sync_seq` y `version + 1` y viaja por
   * /vehicles/changes. Es correcto: la fila cambió. Efecto aceptado: un cliente
   * con la `version` vieja cacheada come 409 en su próximo PATCH.
   *
   * OJO — `tenantId` va EXPLÍCITO en todos los `where` de adentro, lecturas
   * incluidas. Es la primera transacción interactiva del repo y no está
   * garantizado que la extensión `prismaForTenant` se propague al `tx`. Así el
   * código es correcto se propague o no. El `tenantId` sale del
   * `TenantContextService`, nunca de un argumento del método.
   */
  async deleteVehicleType(
    typeId: string,
    expectedVersion: number,
    reassignToTypeId?: string,
  ): Promise<DeleteVehicleTypeResultDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const instance = `/tenants/${tenantId}/vehicle-types/${typeId}`;

    return tenantPrisma.$transaction(async (tx) => {
      let target: { id: string } | null = null;

      if (reassignToTypeId !== undefined) {
        if (reassignToTypeId === typeId) {
          throw this.badRequest(
            ErrorCodes.VEHICLE_TYPE_REASSIGN_TARGET_INVALID,
            'The reassignment target cannot be the type being deleted.',
            instance,
          );
        }
        target = await tx.vehicleType.findFirst({
          where: { id: reassignToTypeId, tenantId, deletedAt: null },
          select: { id: true },
        });
        // No distingue "no existe" de "es de otro estacionamiento": sería un
        // oráculo de existencia (IDOR).
        if (!target) {
          throw this.badRequest(
            ErrorCodes.VEHICLE_TYPE_REASSIGN_TARGET_INVALID,
            `Vehicle type ${reassignToTypeId} is not a valid reassignment target.`,
            instance,
          );
        }
      }

      const marked = await tx.vehicleType.updateMany({
        where: {
          id: typeId,
          tenantId,
          version: expectedVersion,
          deletedAt: null,
        },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      if (marked.count === 0) {
        this.throwWriteFailure(
          typeId,
          tenantId,
          await tx.vehicleType.findFirst({ where: { id: typeId, tenantId } }),
        );
      }

      const inUse = await tx.vehicle.count({
        where: { tenantId, typeId, deletedAt: null },
      });

      if (inUse > 0 && !target) {
        // Revierte el soft delete. El cliente ya sabía el número por
        // `vehicleCount`; este 409 es la red contra la carrera (alguien creó un
        // vehículo mientras el modal estaba abierto).
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `${inUse} vehicle(s) still use this type. Retry with reassignToTypeId.`,
          instance,
          ErrorCodes.VEHICLE_TYPE_IN_USE,
        );
      }

      if (inUse > 0 && target) {
        await tx.vehicle.updateMany({
          where: { tenantId, typeId, deletedAt: null },
          data: { typeId: target.id },
        });
      }

      return {
        reassignedVehicles: target ? inUse : 0,
        reassignedToTypeId: target?.id ?? null,
      };
    });
  }

  /**
   * Convierte un `count === 0` de la escritura atómica en el error correcto.
   * Siempre tira.
   *
   * Recibe la fila ya buscada en vez del cliente: la búsqueda tiene que hacerla
   * el llamador con el cliente que tenga a mano (el tenant, o el `tx` de la
   * transacción), y el tipo del `tx` de un cliente extendido no coincide con
   * `Prisma.TransactionClient`. Así el helper queda puro y sirve para los dos.
   *
   * Como esa búsqueda va siempre por un cliente con scope de tenant, una fila
   * de otro estacionamiento llega acá como `null` y sale como
   * `VEHICLE_TYPE_NOT_FOUND`: el anti-IDOR queda garantizado por construcción.
   */
  private throwWriteFailure(
    typeId: string,
    tenantId: string,
    row: VehicleType | null,
  ): never {
    const instance = `/tenants/${tenantId}/vehicle-types/${typeId}`;

    if (!row) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Vehicle type ${typeId} not found`,
        instance,
        ErrorCodes.VEHICLE_TYPE_NOT_FOUND,
      );
    }

    throw new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      row.deletedAt !== null
        ? 'Vehicle type was already deleted.'
        : 'Vehicle type was changed by another write. Refresh and retry with the latest version.',
      instance,
      ErrorCodes.CONFLICT,
    );
  }

  private badRequest(
    code: ErrorCode,
    detail: string,
    instance: string,
  ): FormattedException {
    return new FormattedException(
      'Bad Request',
      HttpStatus.BAD_REQUEST,
      detail,
      instance,
      code,
    );
  }

  /** P2002 sobre `vehicle_types_tenant_name_uidx` -> 409 duplicado. */
  private mapUniqueViolation(
    error: unknown,
    tenantId: string,
    name: string,
  ): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `A vehicle type named "${name}" already exists in this entity.`,
        `/tenants/${tenantId}/vehicle-types`,
        ErrorCodes.VEHICLE_TYPE_DUPLICATE,
      );
    }
    return error;
  }
}
