import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DriverVehiclesService } from './driver-vehicles.service';
import { DriverVehicleCatalogItemDto } from './dto/driver-vehicle-catalog.dto';

// Catálogo global de marcas y modelos (el mismo que siembra cada playa nueva).
// Cualquier conductor logueado: sólo JwtAuthGuard, sin tenant.
@ApiTags('Driver')
@Controller('driver/vehicle-catalog')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class DriverVehicleCatalogController {
  constructor(private readonly vehicles: DriverVehiclesService) {}

  @Get()
  // Unas 1.200 filas que sólo cambian por migración: se cachea en el cliente.
  // `private` porque la respuesta viaja con Authorization.
  @Header('Cache-Control', 'private, max-age=86400')
  @ApiOperation({
    operationId: 'driverVehicleCatalogList',
    summary: 'Platform vehicle catalog (brand, model, category)',
    description:
      'Todas las marcas y modelos de la plataforma, ordenados por marca y ' +
      'modelo, con su categoría. Sirve para que el conductor busque su ' +
      'vehículo y la categoría quede precargada (editable). Es una sola ' +
      'respuesta de unas 1.200 filas, cacheable.',
  })
  @ApiOkResponse({ type: [DriverVehicleCatalogItemDto] })
  list(): Promise<DriverVehicleCatalogItemDto[]> {
    return this.vehicles.listCatalog();
  }
}
