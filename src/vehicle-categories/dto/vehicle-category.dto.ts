import { ApiProperty } from '@nestjs/swagger';
import {
  RESERVABLE_VEHICLE_CATEGORIES,
  VEHICLE_CATEGORIES,
  type VehicleCategory,
} from '../vehicle-categories';

/**
 * Se publica como enum `VehicleCategory` de OpenAPI: los frontends lo importan
 * de los tipos generados en vez de redeclarar la lista.
 */
export const VEHICLE_CATEGORY_API_PROPERTY = {
  enum: VEHICLE_CATEGORIES,
  enumName: 'VehicleCategory',
} as const;

/**
 * Subconjunto reservable (auto, SUV, pickup, utilitario y moto), como enum
 * `ReservableVehicleCategory` de OpenAPI.
 */
export const RESERVABLE_VEHICLE_CATEGORY_API_PROPERTY = {
  enum: RESERVABLE_VEHICLE_CATEGORIES,
  enumName: 'ReservableVehicleCategory',
} as const;

export class VehicleCategoryDto {
  @ApiProperty({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    example: 'suv',
    description: 'Código fijo de la categoría. Es lo que se guarda y se envía.',
  })
  code: VehicleCategory;

  @ApiProperty({ example: 'Utilitario / Van', maxLength: 40 })
  label: string;

  @ApiProperty({
    type: Number,
    description: 'Orden de presentación (1 a 8).',
  })
  sortOrder: number;

  @ApiProperty({
    description:
      'Si se puede reservar desde la app del conductor (auto, SUV, pickup, ' +
      'utilitario y moto).',
  })
  reservable: boolean;
}
