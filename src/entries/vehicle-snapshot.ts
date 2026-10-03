import type { Prisma } from '@prisma/client';
import {
  inferCategoryFromName,
  isVehicleCategory,
  type VehicleCategory,
} from '../vehicle-categories/vehicle-categories';

/** Lo que un ingreso congela del vehículo al registrarse. */
export interface VehicleSnapshot {
  vehicleTypeId: string | null;
  /** Nombre del tipo (snapshot de texto: no cambia si el dueño renombra). */
  vehicleType: string | null;
  vehicleCategory: VehicleCategory | null;
}

export interface VehicleSnapshotInput {
  vehicleTypeId?: string | null;
  vehicleCategory?: string | null;
  /** Sólo lo manda el ingreso por cámara (LPR): el nombre del tipo, en texto. */
  vehicleType?: string | null;
}

export const EMPTY_VEHICLE_SNAPSHOT: VehicleSnapshot = {
  vehicleTypeId: null,
  vehicleType: null,
  vehicleCategory: null,
};

/**
 * Arma lo que se guarda del vehículo en un ingreso, a partir de lo que mandó el
 * cliente. Nunca rechaza: un ingreso con plata adentro no se pierde por un tipo
 * que no cierra, así que lo que no se puede resolver queda en `null`.
 *
 * Orden de resolución:
 *
 *   1. `vehicleTypeId`: se busca el tipo DEL TENANT, borrado o no (una caja sin
 *      conexión puede ingresar con un tipo que el dueño borró mientras tanto, y
 *      el historial lo tiene que seguir mostrando). Si está, MANDA el tipo: de
 *      ahí salen la categoría y el nombre, y la categoría que mandó el cliente
 *      se ignora. Un id que no es del tenant se trata como inexistente: no se
 *      guarda, para no persistir un uuid ajeno ni distinguir "no existe" de "es
 *      de otro estacionamiento".
 *   2. `vehicleType` (nombre, sólo LPR): se busca entre los tipos vivos del
 *      tenant por nombre (sin distinguir mayúsculas). Si no está, se intenta
 *      adivinar la categoría por el nombre.
 *   3. `vehicleCategory`: se usa tal cual si es válida. El tipo queda sin id.
 *
 * `tenantId` va explícito en el `where` y nunca sale del input.
 */
export async function resolveVehicleSnapshot(
  db: Pick<Prisma.TransactionClient, 'vehicleType'>,
  tenantId: string,
  input: VehicleSnapshotInput,
): Promise<VehicleSnapshot> {
  const clientCategory = isVehicleCategory(input.vehicleCategory)
    ? input.vehicleCategory
    : null;
  const clientName = input.vehicleType?.trim() || null;

  if (input.vehicleTypeId) {
    const type = await db.vehicleType.findFirst({
      where: { id: input.vehicleTypeId, tenantId },
      select: { id: true, name: true, category: true },
    });
    if (type) {
      return {
        vehicleTypeId: type.id,
        vehicleType: type.name,
        vehicleCategory: isVehicleCategory(type.category)
          ? type.category
          : clientCategory,
      };
    }
  }

  if (clientName) {
    const type = await db.vehicleType.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        name: { equals: clientName, mode: 'insensitive' },
      },
      select: { id: true, name: true, category: true },
    });
    if (type) {
      return {
        vehicleTypeId: type.id,
        vehicleType: type.name,
        vehicleCategory: isVehicleCategory(type.category)
          ? type.category
          : clientCategory,
      };
    }
  }

  return {
    vehicleTypeId: null,
    vehicleType: clientName,
    vehicleCategory:
      clientCategory ?? (clientName ? inferCategoryFromName(clientName) : null),
  };
}
