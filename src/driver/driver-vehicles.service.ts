import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type DriverVehicle, type User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { holdingWhere } from '../reservations/reservation-capacity';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { isVehicleCategory } from '../vehicle-categories/vehicle-categories';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { DriverVehicleCatalogItemDto } from './dto/driver-vehicle-catalog.dto';
import {
  CreateDriverVehicleDto,
  DriverVehicleDto,
  UpdateDriverVehicleDto,
} from './dto/driver-vehicle.dto';

const VEHICLES_PATH = '/driver/vehicles';

type Tx = Prisma.TransactionClient;

/**
 * Vehículos del conductor (SCRUM-285). Globales: se leen y escriben siempre
 * por `user_id`, nunca por playa.
 *
 * Reglas:
 * - Patente única por conductor (`driver_vehicles_user_plate_key`).
 * - Un solo principal: el primero lo es siempre; marcar otro desmarca al
 *   anterior y borrar el principal promueve al más antiguo.
 * - Con una reserva activa (confirmada y sin terminar) del vehículo no se lo
 *   borra ni se le cambia patente o categoría: la reserva se reconoce en la
 *   playa por esa patente.
 * - Marca y modelo salen del catálogo de la plataforma (SCRUM-301): no se
 *   guarda texto libre. Se acepta el par marca + modelo, la marca sola o
 *   ninguno. Los vehículos cargados antes de esta regla quedan como están
 *   mientras no se les cambie marca o modelo.
 */
@Injectable()
export class DriverVehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: User, now = new Date()): Promise<DriverVehicleDto[]> {
    const vehicles = await this.prisma.driverVehicle.findMany({
      where: { userId: user.id },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    const active = await this.activePlates(this.prisma, user.id, now);
    return vehicles.map((vehicle) => toDto(vehicle, active));
  }

  async create(
    user: User,
    dto: CreateDriverVehicleDto,
    now = new Date(),
  ): Promise<DriverVehicleDto> {
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const count = await tx.driverVehicle.count({
          where: { userId: user.id },
        });
        const isPrimary = count === 0 || dto.isPrimary === true;
        const catalog = await this.resolveCatalogVehicle(
          tx,
          dto.brand ?? null,
          dto.model ?? null,
          VEHICLES_PATH,
        );
        if (isPrimary) await clearPrimary(tx, user.id);
        return tx.driverVehicle.create({
          data: {
            userId: user.id,
            plate: dto.plate,
            category: dto.category,
            brand: catalog.brand,
            model: catalog.model,
            isPrimary,
          },
        });
      });
      return toDto(created, await this.activePlates(this.prisma, user.id, now));
    } catch (error) {
      throw plateTakenOr(error);
    }
  }

  async update(
    user: User,
    vehicleId: string,
    dto: UpdateDriverVehicleDto,
    now = new Date(),
  ): Promise<DriverVehicleDto> {
    const instance = `${VEHICLES_PATH}/${vehicleId}`;
    if (dto.isPrimary === false) {
      throw failure(
        HttpStatus.BAD_REQUEST,
        'Mark another vehicle as primary instead.',
        instance,
        ErrorCodes.DRIVER_VEHICLE_PRIMARY_REQUIRED,
      );
    }
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const vehicle = await this.findOwned(tx, user, vehicleId, instance);
        const changesIdentity =
          (dto.plate !== undefined && dto.plate !== vehicle.plate) ||
          (dto.category !== undefined && dto.category !== vehicle.category);
        if (changesIdentity) {
          await this.assertNoActiveReservation(tx, vehicle, now, instance);
        }
        // Sólo se valida si cambian: un vehículo anterior a la regla se puede
        // seguir editando (patente, principal) sin que su texto viejo lo trabe.
        const brand = dto.brand !== undefined ? dto.brand : vehicle.brand;
        const model = dto.model !== undefined ? dto.model : vehicle.model;
        const catalog =
          brand !== vehicle.brand || model !== vehicle.model
            ? await this.resolveCatalogVehicle(tx, brand, model, instance)
            : null;
        if (dto.isPrimary === true && !vehicle.isPrimary) {
          await clearPrimary(tx, user.id);
        }
        return tx.driverVehicle.update({
          where: { id: vehicle.id },
          data: {
            ...(dto.plate !== undefined && { plate: dto.plate }),
            ...(dto.category !== undefined && { category: dto.category }),
            ...(catalog && { brand: catalog.brand, model: catalog.model }),
            ...(dto.isPrimary === true && { isPrimary: true }),
          },
        });
      });
      return toDto(updated, await this.activePlates(this.prisma, user.id, now));
    } catch (error) {
      throw plateTakenOr(error);
    }
  }

  async remove(user: User, vehicleId: string, now = new Date()): Promise<void> {
    const instance = `${VEHICLES_PATH}/${vehicleId}`;
    await this.prisma.$transaction(async (tx) => {
      const vehicle = await this.findOwned(tx, user, vehicleId, instance);
      await this.assertNoActiveReservation(tx, vehicle, now, instance);
      await tx.driverVehicle.delete({ where: { id: vehicle.id } });
      if (!vehicle.isPrimary) return;
      const next = await tx.driverVehicle.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await tx.driverVehicle.update({
          where: { id: next.id },
          data: { isPrimary: true },
        });
      }
    });
  }

  /**
   * Catálogo de la plataforma (`vehicle_catalog_defaults`): marca, modelo y
   * categoría. Global, sin tenant. Ordenado como lo mostraría un buscador.
   */
  async listCatalog(): Promise<DriverVehicleCatalogItemDto[]> {
    const rows = await this.prisma.vehicleCatalogDefault.findMany({
      orderBy: [{ brand: 'asc' }, { model: 'asc' }],
    });
    return rows.flatMap((row) =>
      isVehicleCategory(row.category)
        ? [{ brand: row.brand, model: row.model, category: row.category }]
        : [],
    );
  }

  /**
   * Categoría del vehículo del conductor con esa patente, o `null` si la
   * patente no es de ninguno de sus vehículos (reservas, SCRUM-285). La
   * categoría decide si la playa deja reservar.
   */
  async findOwnedCategory(user: User, plate: string): Promise<string | null> {
    const vehicle = await this.prisma.driverVehicle.findUnique({
      where: { userId_plate: { userId: user.id, plate } },
      select: { category: true },
    });
    return vehicle?.category ?? null;
  }

  /**
   * Marca y modelo tal como están escritos en el catálogo, o 400 si no están.
   * La comparación ignora mayúsculas, pero se guarda la grafía del catálogo
   * para que no queden variantes ("toyota", "TOYOTA") de lo mismo.
   */
  private async resolveCatalogVehicle(
    tx: Tx,
    brand: string | null,
    model: string | null,
    instance: string,
  ): Promise<{ brand: string | null; model: string | null }> {
    if (brand === null && model === null) return { brand: null, model: null };
    const row =
      brand === null
        ? null
        : await tx.vehicleCatalogDefault.findFirst({
            where: {
              brand: { equals: brand, mode: 'insensitive' },
              ...(model !== null && {
                model: { equals: model, mode: 'insensitive' },
              }),
            },
            orderBy: [{ brand: 'asc' }, { model: 'asc' }],
            select: { brand: true, model: true },
          });
    if (!row) {
      throw failure(
        HttpStatus.BAD_REQUEST,
        'Brand and model must come from the vehicle catalog.',
        instance,
        ErrorCodes.DRIVER_VEHICLE_NOT_IN_CATALOG,
      );
    }
    return { brand: row.brand, model: model === null ? null : row.model };
  }

  private async findOwned(
    tx: Tx,
    user: User,
    vehicleId: string,
    instance: string,
  ): Promise<DriverVehicle> {
    const vehicle = await tx.driverVehicle.findFirst({
      where: { id: vehicleId, userId: user.id },
    });
    if (!vehicle) {
      throw failure(
        HttpStatus.NOT_FOUND,
        'Vehicle not found.',
        instance,
        ErrorCodes.DRIVER_VEHICLE_NOT_FOUND,
      );
    }
    return vehicle;
  }

  private async assertNoActiveReservation(
    tx: Tx,
    vehicle: DriverVehicle,
    now: Date,
    instance: string,
  ): Promise<void> {
    const active = await this.activePlates(tx, vehicle.userId, now);
    if (active.has(vehicle.plate)) {
      throw failure(
        HttpStatus.CONFLICT,
        'The vehicle has an active reservation.',
        instance,
        ErrorCodes.DRIVER_VEHICLE_HAS_ACTIVE_RESERVATION,
      );
    }
  }

  /** Patentes con una reserva que retiene lugar y todavía no terminó. */
  private async activePlates(
    client: Tx | PrismaService,
    userId: string,
    now: Date,
  ): Promise<Set<string>> {
    const rows = await client.reservation.findMany({
      where: {
        userId,
        ...holdingWhere(now),
        exitAt: { gt: now },
      },
      select: { vehiclePlate: true },
      distinct: ['vehiclePlate'],
    });
    return new Set(rows.map((row) => row.vehiclePlate));
  }
}

async function clearPrimary(tx: Tx, userId: string): Promise<void> {
  await tx.driverVehicle.updateMany({
    where: { userId, isPrimary: true },
    data: { isPrimary: false },
  });
}

function toDto(vehicle: DriverVehicle, activePlates: Set<string>) {
  return {
    id: vehicle.id,
    plate: vehicle.plate,
    // La FK admite toda la lista aunque la API sólo guarde reservables.
    category: isVehicleCategory(vehicle.category) ? vehicle.category : 'other',
    brand: vehicle.brand,
    model: vehicle.model,
    isPrimary: vehicle.isPrimary,
    hasActiveReservation: activePlates.has(vehicle.plate),
    createdAt: vehicle.createdAt.toISOString(),
  };
}

function plateTakenOr(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    return failure(
      HttpStatus.CONFLICT,
      'You already have a vehicle with that plate.',
      VEHICLES_PATH,
      ErrorCodes.DRIVER_VEHICLE_PLATE_TAKEN,
    );
  }
  return error;
}

function failure(
  status: HttpStatus,
  detail: string,
  instance: string,
  code: ErrorCode,
) {
  const title =
    status === HttpStatus.NOT_FOUND
      ? 'Not Found'
      : status === HttpStatus.BAD_REQUEST
        ? 'Bad Request'
        : 'Conflict';
  return new FormattedException(title, status, detail, instance, code);
}
