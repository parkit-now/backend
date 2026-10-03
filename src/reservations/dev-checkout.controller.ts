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
import { ReservationLifecycleService } from './reservation-lifecycle.service';

/** Cuerpo del formulario (`application/x-www-form-urlencoded`). */
export class DevCheckoutDecisionDto {
  /** La casilla "forzar reembolso fallido": llega como `on` si está tildada. */
  @IsOptional()
  @IsString()
  failRefund?: string;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] as string,
  );

const page = (title: string, body: string): string => `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  .card{border:1px solid #ddd;border-radius:12px;padding:1.25rem}
  .tag{display:inline-block;background:#fff3cd;border-radius:6px;padding:.1rem .5rem;font-size:.8rem}
  dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#666}dd{margin:0}
  button{width:100%;padding:.8rem;margin-top:.6rem;border:0;border-radius:8px;font-size:1rem;cursor:pointer}
  .ok{background:#16a34a;color:#fff}.no{background:#dc2626;color:#fff}
  label{display:block;margin-top:.8rem;font-size:.9rem}
</style></head><body>${body}</body></html>`;

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

function withResult(
  returnUrl: string,
  reservationId: string,
  status: string,
): string {
  try {
    const url = new URL(returnUrl);
    url.searchParams.set('reservationId', reservationId);
    url.searchParams.set('status', status);
    return url.toString();
  } catch {
    const separator = returnUrl.includes('?') ? '&' : '?';
    return `${returnUrl}${separator}reservationId=${reservationId}&status=${status}`;
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
