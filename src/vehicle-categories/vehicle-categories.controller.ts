import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProblemDetailsDto } from '../utils/exceptions/dto/problem-details.dto';
import { VehicleCategoryDto } from './dto/vehicle-category.dto';
import { VehicleCategoriesService } from './vehicle-categories.service';

/**
 * Lista global de categorías de vehículo. Sólo JWT: no depende de ningún
 * estacionamiento, así que la leen igual el dueño (web), la caja (desktop) y el
 * conductor (mobile).
 */
@ApiTags('Vehicle categories')
@ApiBearerAuth()
@Controller('vehicle-categories')
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid bearer token.',
  type: ProblemDetailsDto,
})
export class VehicleCategoriesController {
  constructor(private readonly categories: VehicleCategoriesService) {}

  @Get()
  // Ocho filas que sólo cambian por migración. `private` porque la respuesta
  // viaja con Authorization: ningún caché compartido la tiene que guardar.
  @Header('Cache-Control', 'private, max-age=3600')
  @ApiOperation({
    operationId: 'vehicleCategoriesList',
    summary: 'List the platform vehicle categories',
    description:
      'Las 8 categorías de la plataforma, ordenadas por `sortOrder`. Lista ' +
      'cerrada: se cambia sólo por migración. No requiere tenant.',
  })
  @ApiOkResponse({ type: [VehicleCategoryDto] })
  list(): Promise<VehicleCategoryDto[]> {
    return this.categories.list();
  }
}
