import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DriverReservationsService } from './driver-reservations.service';
import {
  CreateReservationDto,
  DriverReservationDto,
} from './dto/reservation.dto';

// Reservas del conductor logueado. Cada operación se acota a SUS reservas
// (user_id), no a una playa: sólo JwtAuthGuard.
@ApiTags('Driver')
@Controller('driver/reservations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class DriverReservationsController {
  constructor(private readonly reservations: DriverReservationsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Create a reservation (idempotent by client id): re-quotes on the server and checks capacity',
  })
  @ApiOkResponse({ type: DriverReservationDto })
  create(@CurrentUser() user: User, @Body() dto: CreateReservationDto) {
    return this.reservations.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: "The signed-in driver's reservations" })
  @ApiOkResponse({ type: [DriverReservationDto] })
  list(@CurrentUser() user: User) {
    return this.reservations.list(user);
  }

  @Post(':reservationId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a reservation that has not started yet' })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: DriverReservationDto })
  cancel(
    @CurrentUser() user: User,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.cancel(user, reservationId);
  }
}
