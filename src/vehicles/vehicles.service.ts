import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Vehicle } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCode, ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import {
  ListVehiclesQueryDto,
  VehicleScope,
} from './dto/list-vehicles-query.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VehicleCatalogChangesQueryDto,
  VehicleCatalogChangesResponseDto,
  VehicleCatalogItemDto,
} from './dto/vehicle-catalog.dto';

function toDto(v: Vehicle): VehicleCatalogItemDto {
  return {
    id: v.id,
    brand: v.brand,
    model: v.model,
    type: v.type ?? null,
    tenantId: v.tenantId ?? null,
    version: v.version,
    syncSeq: v.syncSeq,
    deletedAt: v.deletedAt ? v.deletedAt.toISOString() : null,
    updatedAt: v.updatedAt.toISOString(),
    createdAt: v.createdAt.toISOString(),
  };
}

/**
 * Catálogo de vehículos: los globales de la plataforma (`tenant_id IS NULL`,
 * read-only) más los propios de cada estacionamiento.
 *
 * POR QUÉ NO SE USA `getTenantClient()`
 *
 * `Vehicle` es una tabla GLOBAL y está deliberadamente FUERA de `TENANT_MODELS`
 * (src/database/prisma-tenant.ts). La extensión tenant inyecta
 * `WHERE tenantId = <ctx>` en TODA lectura, lo que ocultaría cada fila con
 * `tenant_id IS NULL` — o sea el catálogo global entero, que es justo lo que un
 * estacionamiento tiene que poder leer.
 *
 * Por eso este service usa el cliente base y escribe el scope a mano:
 *   lecturas   -> OR: [{ tenantId: null }, { tenantId }]
 *   escrituras -> tenantId (nunca null): los globales son read-only vía API.
 *
 * El `tenantId` igual sale SIEMPRE de `TenantContextService`, nunca de un
 * argumento del método.
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Listado plano para el ABM: globales + los del estacionamiento, sin bajas.
   *
   * Al revés que `pullCatalogChanges`, acá SÍ se filtra `deletedAt`: esto es una
   * vista de usuario, no el feed de sync. Mandar tombstones a la tabla del ABM
   * mostraría vehículos ya borrados.
   */
  async listVehicles(
    query: ListVehiclesQueryDto,
  ): Promise<VehicleCatalogItemDto[]> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const scope: Prisma.VehicleWhereInput =
      query.scope === VehicleScope.tenant
        ? { tenantId }
        : query.scope === VehicleScope.global
          ? { tenantId: null }
          : { OR: [{ tenantId: null }, { tenantId }] };

    const rows = await this.prisma.vehicle.findMany({
      where: { ...scope, deletedAt: null },
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
  async pullCatalogChanges(
    query: VehicleCatalogChangesQueryDto,
  ): Promise<VehicleCatalogChangesResponseDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const items = await this.prisma.vehicle.findMany({
      where: {
        OR: [{ tenantId: null }, { tenantId }],
        syncSeq: { gt: query.afterSeq },
      },
      orderBy: { syncSeq: 'asc' },
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  async createTenantVehicle(
    data: CreateVehicleDto,
  ): Promise<VehicleCatalogItemDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    await this.assertNoClash(tenantId, data.brand, data.model);

    try {
      const v = await this.prisma.vehicle.create({
        data: {
          id: data.id,
          brand: data.brand,
          model: data.model,
          type: data.type ?? null,
          // Siempre el del contexto: no hay forma de crear un global vía HTTP.
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
  ): Promise<VehicleCatalogItemDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    if (data.brand !== undefined || data.model !== undefined) {
      const current = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
      });
      if (current) {
        await this.assertNoClash(
          tenantId,
          data.brand ?? current.brand,
          data.model ?? current.model,
          vehicleId,
        );
      }
    }

    // `version: { increment: 1 }` es REDUNDANTE en esta tabla: el trigger
    // `set_vehicles_sync_fields` pisa NEW.version con OLD.version + 1 en cada
    // UPDATE — exactamente el mismo valor que computa Prisma con
    // `SET version = version + 1`. No hay doble incremento.
    //
    // Se deja igual por dos razones: garantiza que `data` nunca quede vacío (un
    // PATCH con el body todo-undefined llegaría a Prisma como `data: {}`), y
    // deja el service leyéndose idéntico a RatesService, donde la app SÍ es lo
    // único que bumpea la versión.
    const updateData: Prisma.VehicleUpdateManyMutationInput = {
      version: { increment: 1 },
    };
    if (data.brand !== undefined) updateData.brand = data.brand;
    if (data.model !== undefined) updateData.model = data.model;
    if (data.type !== undefined) updateData.type = data.type;

    let result: { count: number };
    try {
      // Compare-and-swap atómico. El `tenantId` no-nulo en el WHERE es lo que
      // hace que un vehículo GLOBAL (tenant_id IS NULL) nunca matchee: los
      // globales son read-only desde la API del estacionamiento.
      result = await this.prisma.vehicle.updateMany({
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
      await this.prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }),
    );
  }

  /**
   * Borrado lógico: estampa `deletedAt` en vez de borrar la fila.
   *
   * El trigger `set_vehicles_sync_fields` bumpea `sync_seq` en cualquier UPDATE,
   * así que la fila marcada sigue viajando por `pullCatalogChanges` como
   * tombstone y los clientes offline pueden borrarla local. Un DELETE físico no
   * emite nada.
   *
   * `deletedAt: null` en el WHERE es el guard contra el doble DELETE: sin él, un
   * segundo DELETE re-estampa la marca, dispara el trigger, bumpea `sync_seq` y
   * re-emite el tombstone — ruido puro en el feed de todos los clientes.
   */
  async deleteTenantVehicle(
    vehicleId: string,
    expectedVersion: number,
  ): Promise<void> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const result = await this.prisma.vehicle.updateMany({
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
   * Rechaza una marca/modelo que ya exista, sea como propia o como global.
   *
   * `vehicles_scope_brand_model_uidx` llavea por (alcance, marca, modelo), así
   * que una fila del estacionamiento y una global con la misma marca/modelo son
   * DOS claves distintas y la base acepta las dos con gusto. No es lo que espera
   * un operador: "Toyota / Corolla" ya está en el catálogo compartido, y agregar
   * una copia privada solo produce una entrada duplicada en cada autocompletado.
   *
   * Postgres no puede expresar "único por estacionamiento Y que además no exista
   * como global" en un solo índice sin prohibir también que dos estacionamientos
   * distintos tengan el mismo modelo privado — que sí es legítimo. Por eso la
   * colisión global-vs-propio se chequea acá.
   *
   * SQL crudo a propósito: tiene que usar EXACTAMENTE la misma expresión que el
   * índice. El `mode: 'insensitive'` de Prisma compila a ILIKE, que trataría un
   * `%` o un `_` dentro del nombre de un modelo como comodín.
   *
   * Es un chequeo, no un lock: un insert concurrente puede colarse entre el
   * SELECT y el INSERT. El índice único es el guard real — `mapUniqueViolation`
   * convierte su 23505 en el mismo 409.
   */
  private async assertNoClash(
    tenantId: string,
    brand: string,
    model: string,
    excludeVehicleId?: string,
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      { id: string; tenant_id: string | null }[]
    >`
      SELECT id, tenant_id
        FROM vehicles
       WHERE lower(btrim(brand)) = lower(btrim(${brand}))
         AND lower(btrim(model)) = lower(btrim(${model}))
         AND deleted_at IS NULL
         AND (tenant_id IS NULL OR tenant_id = ${tenantId}::uuid)
       LIMIT 2`;

    const clash = rows.find((r) => r.id !== excludeVehicleId);
    if (!clash) return;

    const instance = `/tenants/${tenantId}/vehicles`;
    throw clash.tenant_id === null
      ? new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `${brand} ${model} is already in the global catalog`,
          instance,
          ErrorCodes.VEHICLE_ALREADY_IN_GLOBAL_CATALOG,
        )
      : new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          `${brand} ${model} already exists in this entity's catalog`,
          instance,
          ErrorCodes.VEHICLE_DUPLICATE,
        );
  }

  /**
   * Corre SOLO cuando la escritura atómica no matcheó nada, así que no cuesta
   * nada en el camino feliz. Su único trabajo es convertir `count === 0` en el
   * error correcto. Siempre tira.
   *
   * `RatesService` devuelve un 409 genérico para los cinco casos; acá se
   * distinguen porque el ABM ya renderiza mensajes distintos y porque
   * `VEHICLE_NOT_FOUND` es un contrato ya publicado que consume el desktop.
   */
  private async throwWriteFailure(
    vehicleId: string,
    tenantId: string,
  ): Promise<never> {
    const instance = `/tenants/${tenantId}/vehicles/${vehicleId}`;
    const notFound = (code: ErrorCode, detail: string): FormattedException =>
      new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        detail,
        instance,
        code,
      );
    const conflict = (detail: string): FormattedException =>
      new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        detail,
        instance,
        ErrorCodes.CONFLICT,
      );

    const row = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });

    if (!row) {
      throw notFound(
        ErrorCodes.VEHICLE_NOT_FOUND,
        `Vehicle ${vehicleId} not found`,
      );
    }

    // Global: read-only. No hay leak — quien llama ya lo ve por GET /vehicles.
    if (row.tenantId === null) {
      throw notFound(
        ErrorCodes.VEHICLE_NOT_OWNED_BY_TENANT,
        'Global catalog entries are managed by the platform and cannot be edited or deleted',
      );
    }

    // De OTRO estacionamiento: tiene que verse idéntico a "no existe". Un code o
    // un status distinto sería un oráculo de existencia (IDOR).
    if (row.tenantId !== tenantId) {
      throw notFound(
        ErrorCodes.VEHICLE_NOT_FOUND,
        `Vehicle ${vehicleId} not found`,
      );
    }

    if (row.deletedAt !== null) {
      throw conflict('Vehicle was already deleted.');
    }

    throw conflict(
      'Vehicle was changed by another write. Refresh and retry with the latest version.',
    );
  }

  /**
   * Un 23505 sin manejar ya sale 409 (error-filter-handler mapea P2002), pero
   * con el code genérico `DB_UNIQUE_CONSTRAINT` y un `detail` que filtra el
   * nombre del índice. Esto es un upgrade de code + detail, no un arreglo de 500.
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
        `${brand} ${model} already exists in this entity's catalog`,
        `/tenants/${tenantId}/vehicles`,
        ErrorCodes.VEHICLE_DUPLICATE,
      );
    }
    return error;
  }
}
