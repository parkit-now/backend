import type { User, UserMembership } from '@prisma/client';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentMembership } from '../auth/decorators/entity-role.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import {
  ListOwnerReservationsQueryDto,
  OwnerReservationDetailDto,
  PaginatedOwnerReservationsDto,
  ReservationReasonDto,
} from './dto/owner-reservation.dto';
import { OwnerReservationsService } from './owner-reservations.service';
import type { ReservationActor } from './reservation-lifecycle.service';

/**
 * Quién actúa: el rol que tiene en la playa (dueño u operador) o `admin` si
 * es un administrador global sin membresía.
 */
function actorOf(
  user: User,
  membership: UserMembership | null | undefined,
): ReservationActor {
  return { userId: user.id, role: membership?.role ?? 'admin' };
}

/**
 * Reservas de la playa para su equipo. Sin `@EntityRole`: el dueño y el
 * operador pueden ver y actuar (decisión de producto).
 */
@ApiTags('Reservations')
@Controller('tenants/:tenantId/reservations')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({
  name: 'tenantId',
  description: 'The ID of the tenant (parking lot)',
})
export class OwnerReservationsController {
  constructor(private readonly reservations: OwnerReservationsService) {}

  @Get()
  @ApiOperation({ summary: 'List the reservations of the parking lot' })
  @ApiOkResponse({ type: PaginatedOwnerReservationsDto })
  list(@Query() query: ListOwnerReservationsQueryDto) {
    return this.reservations.list(query);
  }

  @Get(':reservationId')
  @ApiOperation({ summary: 'Reservation detail with payments and refund' })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: OwnerReservationDetailDto })
  get(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.get(tenantId, reservationId);
  }

  @Post(':reservationId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a reservation waiting for approval' })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: OwnerReservationDetailDto })
  accept(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.reservations.accept(
      tenantId,
      reservationId,
      actorOf(user, membership),
    );
  }

  @Post(':reservationId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a reservation waiting for approval (full refund)',
  })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: OwnerReservationDetailDto })
  reject(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: ReservationReasonDto,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.reservations.reject(
      tenantId,
      reservationId,
      dto.reason,
      actorOf(user, membership),
    );
  }

  @Post(':reservationId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a pending_approval or confirmed reservation (full refund)',
  })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: OwnerReservationDetailDto })
  cancel(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: ReservationReasonDto,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.reservations.cancel(
      tenantId,
      reservationId,
      dto.reason,
      actorOf(user, membership),
    );
  }

  @Post(':reservationId/refund/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed refund' })
  @ApiParam({ name: 'reservationId', format: 'uuid' })
  @ApiOkResponse({ type: OwnerReservationDetailDto })
  retryRefund(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.reservations.retryRefund(
      tenantId,
      reservationId,
      actorOf(user, membership),
    );
  }
}
