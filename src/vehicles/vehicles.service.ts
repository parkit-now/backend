import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Vehicle } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCode, ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VehicleChangesQueryDto,
  VehicleChangesResponseDto,
  VehicleDto,
} from './dto/vehicle.dto';

function toDto(v: Vehicle): VehicleDto {
  return {
    id: v.id,
    brand: v.brand,
    model: v.model,
    typeId: v.typeId,
    tenantId: v.tenantId,
    version: v.version,
    syncSeq: v.syncSeq,
    deletedAt: v.deletedAt ? v.deletedAt.toISOString() : null,
    updatedAt: v.updatedAt.toISOString(),
    createdAt: v.createdAt.toISOString(),
  };
}

/**
 * Catálogo de vehículos de un estacionamiento.
 *
 * Ya no existe el alcance "global": `vehicles` es tenant-local y está en
 * `TENANT_MODELS`, así que la extensión `prismaForTenant` inyecta el
 * `WHERE tenantId` en toda lectura y lo asegura en toda escritura. Eso hace
 * innecesario el scoping a mano que tenía este service, y de paso vuelve el
 * comportamiento anti-IDOR una garantía por construcción en vez de un `if`:
 * la fila de otro estacionamiento simplemente no se encuentra.
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Listado plano para el ABM, sin bajas.
   *
   * Al revés que `pullChanges`, acá SÍ se filtra `deletedAt`: esto es una vista
   * de usuario, no el feed de sync. Mandar tombstones a la tabla del ABM
   * mostraría vehículos ya borrados.
   */
  async listVehicles(): Promise<VehicleDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    const rows = await tenantPrisma.vehicle.findMany({
      where: { deletedAt: null },
      orderBy: [{ brand: 'asc' }, { model: 'asc' }],
    });
    return rows.map(toDto);
  }

  /**
   * Feed de sincronización incremental.
   *
   * Deliberadamente NO filtra `deletedAt`: mandar las filas borradas con su
   * `deletedAt` no-nulo es precisamente cómo una baja llega a los clientes
   * offline. Espeja `RatesService.pullChanges`.
   */
  async pullChanges(
    query: VehicleChangesQueryDto,
  ): Promise<VehicleChangesResponseDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.vehicle.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async createTenantVehicle(data: CreateVehicleDto): Promise<VehicleDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    await this.assertTypeExists(data.typeId, tenantId);

    try {
      // El `tenantId` va explícito porque la FK compuesta lo vuelve parte de
      // la relación y Prisma lo exige en el input. La extensión tenant igual
      // lo verifica: un valor distinto al del contexto tira antes de llegar a
      // la base (`assertTenantMatch`).
      const v = await tenantPrisma.vehicle.create({
        data: {
          id: data.id,
          brand: data.brand,
          model: data.model,
          typeId: data.typeId,
          tenantId,
        },
      });
      return toDto(v);
    } catch (error) {
      throw this.mapUniqueViolation(error, tenantId, data.brand, data.model);
    }
  }

  async updateTenantVehicle(
    vehicleId: string,
    expectedVersion: number,
    data: UpdateVehicleDto,
  ): Promise<VehicleDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    if (data.typeId !== undefined) {
      await this.assertTypeExists(data.typeId, tenantId);
    }

    // `version: { increment: 1 }` es REDUNDANTE en esta tabla: el trigger
    // `set_vehicles_sync_fields` pisa NEW.version con OLD.version + 1 en cada
    // UPDATE — exactamente el mismo valor que computa Prisma. No hay doble
    // incremento.
    //
    // Se deja igual por dos razones: garantiza que `data` nunca quede vacío (un
    // PATCH con el body todo-undefined llegaría a Prisma como `data: {}`), y
    // deja el service leyéndose idéntico a RatesService, donde la app SÍ es lo
    // único que bumpea la versión.
    // `Unchecked` y no `VehicleUpdateManyMutationInput` porque `typeId` es un
    // escalar de la relación compuesta y el input "checked" no lo expone.
    const updateData: Prisma.VehicleUncheckedUpdateManyInput = {
      version: { increment: 1 },
    };
    if (data.brand !== undefined) updateData.brand = data.brand;
    if (data.model !== undefined) updateData.model = data.model;
    if (data.typeId !== undefined) updateData.typeId = data.typeId;

    let result: { count: number };
    try {
      // Compare-and-swap atómico.
      result = await tenantPrisma.vehicle.updateMany({
        where: {
          id: vehicleId,
          tenantId,
          version: expectedVersion,
          deletedAt: null,
        },
        data: updateData,
      });
    } catch (error) {
      throw this.mapUniqueViolation(
        error,
        tenantId,
        data.brand ?? '',
        data.model ?? '',
      );
    }

    if (result.count === 0) {
      await this.throwWriteFailure(vehicleId, tenantId);
    }

    return toDto(
      await tenantPrisma.vehicle.findUniqueOrThrow({
        where: { id: vehicleId },
      }),
    );
  }

  /**
   * Borrado LÓGICO: estampa `deletedAt` en vez de sacar la fila.
   *
   * El trigger `vehicles_before_update` bumpea `sync_seq` en cualquier UPDATE,
   * así que la fila marcada sigue viajando por `pullChanges` como tombstone y
   * los clientes offline pueden borrarla localmente. Un DELETE físico no emite
   * nada y el vehículo quedaría para siempre en el IndexedDB del desktop.
   *
   * `deletedAt: null` en el WHERE hace que un segundo DELETE devuelva 409 en
   * vez de re-estampar la marca y re-emitir el tombstone.
   */
  async deleteTenantVehicle(
    vehicleId: string,
    expectedVersion: number,
  ): Promise<void> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const result = await tenantPrisma.vehicle.updateMany({
      where: {
        id: vehicleId,
        tenantId,
        version: expectedVersion,
        deletedAt: null,
      },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });

    if (result.count === 0) {
      await this.throwWriteFailure(vehicleId, tenantId);
    }
  }

  /**
   * El tipo tiene que existir, estar vivo y ser de este estacionamiento.
   *
   * La FK compuesta `vehicles_tenant_type_fkey` es el backstop en la base; esto
   * corre antes para devolver `VEHICLE_TYPE_NOT_FOUND` en vez de un
   * `DB_FOREIGN_KEY_VIOLATION` genérico. Que sea de otro tenant no se distingue
   * de que no exista: sería un oráculo de existencia (IDOR).
   */
  private async assertTypeExists(
    typeId: string,
    tenantId: string,
  ): Promise<void> {
    const tenantPrisma = this.prisma.getTenantClient();
    const type = await tenantPrisma.vehicleType.findFirst({
      where: { id: typeId, deletedAt: null },
      select: { id: true },
    });
    if (type) return;

    throw new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      `Vehicle type ${typeId} not found`,
      `/tenants/${tenantId}/vehicles`,
      ErrorCodes.VEHICLE_TYPE_NOT_FOUND,
    );
  }

  /**
   * Corre SOLO cuando la escritura atómica no matcheó nada, así que no cuesta
   * nada en el camino feliz. Su único trabajo es convertir `count === 0` en el
   * error correcto. Siempre tira.
   *
   * La búsqueda va por el cliente TENANT, así que una fila de otro
   * estacionamiento devuelve `null` y sale como `VEHICLE_NOT_FOUND` sin ningún
   * chequeo explícito: el anti-IDOR queda garantizado por construcción.
   */
  private async throwWriteFailure(
    vehicleId: string,
    tenantId: string,
  ): Promise<never> {
    const tenantPrisma = this.prisma.getTenantClient();
    const instance = `/tenants/${tenantId}/vehicles/${vehicleId}`;
    const conflict = (detail: string): FormattedException =>
      new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        detail,
        instance,
        ErrorCodes.CONFLICT,
      );

    const row = await tenantPrisma.vehicle.findFirst({
      where: { id: vehicleId },
    });

    if (!row) {
      throw this.notFound(
        ErrorCodes.VEHICLE_NOT_FOUND,
        `Vehicle ${vehicleId} not found`,
        instance,
      );
    }

    if (row.deletedAt !== null) {
      throw conflict('Vehicle was already deleted.');
    }

    throw conflict(
      'Vehicle was changed by another write. Refresh and retry with the latest version.',
    );
  }

  private notFound(
    code: ErrorCode,
    detail: string,
    instance: string,
  ): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      detail,
      instance,
      code,
    );
  }

  /**
   * P2002 sobre `vehicles_tenant_brand_model_uidx` -> 409 `VEHICLE_DUPLICATE`.
   *
   * El índice único es el guard REAL de la unicidad, y ahora el único: el
   * `assertNoClash` que había antes existía sólo para atajar la colisión
   * "propio vs global", que ningún índice podía expresar sin prohibir también
   * que dos estacionamientos distintos tuvieran el mismo modelo privado. Sin
   * globales, la restricción entra entera en el índice — y de paso desaparece
   * la carrera entre el SELECT y el INSERT que aquel chequeo admitía tener.
   */
  private mapUniqueViolation(
    error: unknown,
    tenantId: string,
    brand: string,
    model: string,
  ): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `${brand} ${model} already exists in this entity's catalog`.trim(),
        `/tenants/${tenantId}/vehicles`,
        ErrorCodes.VEHICLE_DUPLICATE,
      );
    }
    return error;
  }
}
