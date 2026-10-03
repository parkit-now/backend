import { ApiProperty } from '@nestjs/swagger';
import { VEHICLE_CATEGORY_API_PROPERTY } from '../../vehicle-categories/dto/vehicle-category.dto';
import type { VehicleCategory } from '../../vehicle-categories/vehicle-categories';

/** Un modelo del catálogo de la plataforma, con la categoría que le corresponde. */
export class DriverVehicleCatalogItemDto {
  @ApiProperty({ example: 'Toyota', maxLength: 120 })
  brand: string;

  @ApiProperty({ example: 'Hilux', maxLength: 120 })
  model: string;

  @ApiProperty({
    ...VEHICLE_CATEGORY_API_PROPERTY,
    example: 'pickup',
    description:
      'Categoría del modelo: es la que el conductor ve precargada al elegir ' +
      'marca y modelo (y puede cambiar).',
  })
  category: VehicleCategory;
}
