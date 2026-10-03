import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { escapeHtml, page, withResult } from './checkout-return';
import { isAllowedReturnUrl } from './return-url';

type ReturnStatus = 'approved' | 'rejected' | 'pending';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_BY_RESULT: Record<string, ReturnStatus> = {
  success: 'approved',
  failure: 'rejected',
  pending: 'pending',
};

const MESSAGES: Record<ReturnStatus, string> = {
  approved: 'Recibimos tu pago. Volvé a la app Parkit para ver tu reserva.',
  rejected: 'El pago no se completó. Volvé a la app Parkit para reintentar.',
  pending:
    'Estamos esperando la confirmación del pago. Volvé a la app Parkit para ver tu reserva.',
};

/**
 * Página puente de Checkout Pro: Mercado Pago redirige acá (`back_urls`) y se
 * reenvía al `returnUrl` de la app. Pública: sólo lee el `returnUrl` guardado
 * (re-validado con la allowlist) y nunca falla con 4xx/5xx por un parámetro malo.
 * El estado real lo confirma el webhook; `result` sólo es informativo.
 */
@ApiExcludeController()
@Controller('payments/mp/return')
export class MpReturnController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async handle(
    @Query('reservation') reservation: unknown,
    @Query('result') result: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const status: ReturnStatus =
      (typeof result === 'string' && STATUS_BY_RESULT[result]) || 'pending';
    const reservationId =
      typeof reservation === 'string' && UUID_RE.test(reservation)
        ? reservation
        : null;

    let returnUrl: string | null = null;
    if (reservationId) {
      const payment = await this.prisma.reservationPayment.findFirst({
        where: { reservationId },
        orderBy: { createdAt: 'desc' },
        select: { returnUrl: true },
      });
      returnUrl = payment?.returnUrl ?? null;
    }

    if (reservationId && returnUrl && isAllowedReturnUrl(returnUrl)) {
      res.redirect(
        HttpStatus.FOUND,
        withResult(returnUrl, reservationId, status),
      );
      return;
    }
    res
      .status(HttpStatus.OK)
      .type('html')
      .send(
        page(
          'Volvé a la app Parkit',
          `<div class="card"><h2>Volvé a la app Parkit</h2><p>${escapeHtml(MESSAGES[status])}</p></div>`,
        ),
      );
  }
}
