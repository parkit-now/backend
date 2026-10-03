import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DriverVehiclesService } from './driver-vehicles.service';
import {
  CreateDriverVehicleDto,
  DriverVehicleDto,
  UpdateDriverVehicleDto,
} from './dto/driver-vehicle.dto';

// Vehículos del conductor logueado. Cada operación se acota a SUS vehículos
// (user_id): sólo JwtAuthGuard.
@ApiTags('Driver')
@Controller('driver/vehicles')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class DriverVehiclesController {
  constructor(private readonly vehicles: DriverVehiclesService) {}

  @Get()
  @ApiOperation({
    summary: "The signed-in driver's vehicles, primary first",
  })
  @ApiOkResponse({ type: [DriverVehicleDto] })
  list(@CurrentUser() user: User) {
    return this.vehicles.list(user);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a vehicle (the first one is always primary)',
  })
  @ApiCreatedResponse({ type: DriverVehicleDto })
  create(@CurrentUser() user: User, @Body() dto: CreateDriverVehicleDto) {
    return this.vehicles.create(user, dto);
  }

  @Patch(':vehicleId')
  @ApiOperation({
    summary:
      'Edit a vehicle or mark it as primary (plate and kind are locked while it has an active reservation)',
  })
  @ApiParam({ name: 'vehicleId', format: 'uuid' })
  @ApiOkResponse({ type: DriverVehicleDto })
  update(
    @CurrentUser() user: User,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Body() dto: UpdateDriverVehicleDto,
  ) {
    return this.vehicles.update(user, vehicleId, dto);
  }

  @Delete(':vehicleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a vehicle without an active reservation (the oldest one becomes primary if needed)',
  })
  @ApiParam({ name: 'vehicleId', format: 'uuid' })
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: User,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
  ) {
    return this.vehicles.remove(user, vehicleId);
  }
}
