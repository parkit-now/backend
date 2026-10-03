import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { isProduction } from '../utils/env';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  DevCheckoutGateway,
  devPaymentId,
} from './payment-gateway/dev-checkout.gateway';
import {
  RESERVATION_PAYMENT_GATEWAY,
  type ReservationPaymentGateway,
} from './payment-gateway/reservation-payment-gateway';
import { escapeHtml, page, withResult } from './checkout-return';
import { ReservationLifecycleService } from './reservation-lifecycle.service';

/** Cuerpo del formulario (`application/x-www-form-urlencoded`). */
export class DevCheckoutDecisionDto {
  /** La casilla "forzar reembolso fallido": llega como `on` si está tildada. */
  @IsOptional()
  @IsString()
  failRefund?: string;
}

/**
 * Checkout falso para probar el pago de reservas en local, sin Mercado Pago.
 * Sin autenticación: es SÓLO de desarrollo.
 *
 * Triple cerrojo para que nunca esté en producción: (1) el módulo lo registra
 * sólo si el proveedor efectivo es `dev`, (2) el arranque falla si el proveedor
 * es `dev` con `NODE_ENV=production`, y (3) en cada request se verifica que el
 * gateway inyectado sea el de dev y que no sea producción; si no, 404.
 */
@ApiExcludeController()
@Controller('dev/checkout')
export class DevCheckoutController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: ReservationLifecycleService,
    @Inject(RESERVATION_PAYMENT_GATEWAY)
    private readonly gateway: ReservationPaymentGateway,
  ) {}

  @Get(':reservationId')
  async checkout(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Res() res: Response,
  ): Promise<void> {
    this.assertDev(reservationId);
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { tenant: { select: { name: true } } },
    });
    if (!reservation) throw notFound(reservationId);

    const fmt = (date: Date) =>
      date.toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
      });
    const action = `/dev/checkout/${reservation.id}`;
    res
      .status(HttpStatus.OK)
      .type('html')
      .send(
        page(
          'Checkout de prueba',
          `<div class="card">
  <p><span class="tag">Checkout de desarrollo</span></p>
  <h2>Pagar reserva</h2>
  <dl>
    <dt>Estacionamiento</dt><dd>${escapeHtml(reservation.tenant.name)}</dd>
    <dt>Patente</dt><dd>${escapeHtml(reservation.vehiclePlate)}</dd>
    <dt>Ingreso</dt><dd>${escapeHtml(fmt(reservation.entryAt))}</dd>
    <dt>Egreso</dt><dd>${escapeHtml(fmt(reservation.exitAt))}</dd>
    <dt>Monto</dt><dd><strong>$ ${Number(reservation.totalArs).toLocaleString('es-AR')}</strong></dd>
    <dt>Estado</dt><dd>${escapeHtml(reservation.status)}</dd>
  </dl>
  <form method="post" action="${action}/approve">
    <label><input type="checkbox" name="failRefund" value="on"> Forzar reembolso fallido</label>
    <button class="ok" type="submit">Aprobar</button>
  </form>
  <form method="post" action="${action}/reject">
    <button class="no" type="submit">Rechazar</button>
  </form>
</div>`,
        ),
      );
  }

  @Post(':reservationId/approve')
  async approve(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() body: DevCheckoutDecisionDto,
    @Res() res: Response,
  ): Promise<void> {
    this.assertDev(reservationId);
    const failRefund = body?.failRefund === 'on' || body?.failRefund === 'true';
    const result = await this.lifecycle.markPaid(reservationId, {
      providerPaymentId: devPaymentId(failRefund),
    });
    await this.finish(reservationId, 'approved', result.outcome, res);
  }

  @Post(':reservationId/reject')
  async reject(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Res() res: Response,
  ): Promise<void> {
    this.assertDev(reservationId);
    await this.lifecycle.markPaymentRejected(reservationId);
    await this.finish(reservationId, 'rejected', 'rejected', res);
  }

  /** 302 al `returnUrl` del pago (con el resultado) o una página de "listo". */
  private async finish(
    reservationId: string,
    status: 'approved' | 'rejected',
    outcome: string,
    res: Response,
  ): Promise<void> {
    const payment = await this.prisma.reservationPayment.findFirst({
      where: { reservationId },
      orderBy: { createdAt: 'desc' },
      select: { returnUrl: true },
    });
    if (payment?.returnUrl) {
      res.redirect(
        HttpStatus.FOUND,
        withResult(payment.returnUrl, reservationId, status),
      );
      return;
    }
    res
      .status(HttpStatus.OK)
      .type('html')
      .send(
        page(
          'Listo',
          `<div class="card"><h2>Listo</h2>
<p>Pago ${status === 'approved' ? 'aprobado' : 'rechazado'} (${escapeHtml(outcome)}).</p>
<p>Ya podés volver a la app.</p></div>`,
        ),
      );
  }

  private assertDev(reservationId: string): void {
    if (isProduction() || !(this.gateway instanceof DevCheckoutGateway)) {
      throw notFound(reservationId);
    }
  }
}

function notFound(reservationId: string) {
  return new FormattedException(
    'Not Found',
    HttpStatus.NOT_FOUND,
    'Not found.',
    `/dev/checkout/${reservationId}`,
    ErrorCodes.RESERVATION_NOT_FOUND,
  );
}
