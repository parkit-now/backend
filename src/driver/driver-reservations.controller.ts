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
  CancelPreviewDto,
  CreateReservationDto,
  CreateReservationResponseDto,
  DriverReservationDetailDto,
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
  @ApiOkResponse({
    type: CreateReservationResponseDto,
    description:
      '{ reservation, payment }: la reserva nace pending_payment y payment ' +
      'trae el checkout. Sin returnUrl: 422 RESERVATION_CLIENT_OUTDATED.',
  })
  create(@CurrentUser() user: User, @Body() dto: CreateReservationDto) {
    return this.reservations.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: "The signed-in driver's reservations" })
  @ApiOkResponse({ type: [DriverReservationDetailDto] })
  list(@CurrentUser() user: User) {
    return this.reservations.list(user);
  }

  @Get(':reservationId')
  @ApiOperation({ summary: 'One of the signed-in driver reservations' })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: DriverReservationDetailDto })
  get(
    @CurrentUser() user: User,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.get(user, reservationId);
  }

  @Post(':reservationId/payment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ask again for the checkout of a pending_payment reservation (same URL while alive, new one after a rejection)',
  })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: CreateReservationResponseDto })
  payment(
    @CurrentUser() user: User,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.paymentRetry(user, reservationId);
  }

  @Get(':reservationId/cancel-preview')
  @ApiOperation({ summary: 'What cancelling now would refund' })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: CancelPreviewDto })
  cancelPreview(
    @CurrentUser() user: User,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.cancelPreview(user, reservationId);
  }

  @Post(':reservationId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a reservation that has not started yet (refund per policy)',
  })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: DriverReservationDetailDto })
  cancel(
    @CurrentUser() user: User,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.cancel(user, reservationId);
  }
}
