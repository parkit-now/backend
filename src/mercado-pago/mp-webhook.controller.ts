import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ProblemDetailsDto } from '../utils/exceptions/dto/problem-details.dto';
import { MpWebhookService } from './mp-webhook.service';

/**
 * Notificaciones (IPN) de Mercado Pago sobre las `Order` de los cobros con QR.
 *
 * ## 🔴 Por qué NO tiene guards, y por qué no es un descuido
 *
 * Quien llama es Mercado Pago, no una persona: no hay bearer de Supabase que
 * poner ni membresía que chequear, y la ruta tampoco puede llevar `:tenantId`
 * —la URL del webhook se registra UNA vez a nivel aplicación, igual que el
 * `redirect_uri` del OAuth (ver `MpOauthController`)—. La playa se deduce de la
 * fila del intento que la orden referencia.
 *
 * Que sea público NO significa que sea abierto: **la autenticación es la firma
 * HMAC** (`x-signature`), y una notificación que no valide se responde 401 sin
 * tocar la base. Precedente de controller sin guard de clase:
 * `src/password-recovery/password-recovery.controller.ts`.
 *
 * ## 🔴 Y por qué NO hay `@Body()` con un DTO
 *
 * `main.ts` tiene `forbidNonWhitelisted: true` en el `ValidationPipe` global:
 * con un DTO, el día que Mercado Pago sume un campo al cuerpo este endpoint
 * devolvería 400, Mercado Pago lo leería como entrega fallida y reintentaría
 * cada 15 minutos para siempre — además de voltear el check `webhooks_ipn` de
 * la homologación. El cuerpo llega crudo (parser `raw` registrado para esta
 * ruta en `main.ts`) y se lee a mano, campo por campo, en `MpWebhookService`.
 *
 * ## Este controller no decide NADA
 *
 * Extrae los tres escalares que la firma cubre (header `x-signature`, header
 * `x-request-id`, query `data.id`), pasa el cuerpo sin interpretar y delega.
 * Toda la máquina de estados vive en el service, que es donde se la puede
 * testear sin levantar HTTP.
 */
@ApiTags('Mercado Pago')
@ApiExtraModels(ProblemDetailsDto)
@Controller('integrations/mercadopago/webhook')
export class MpWebhookController {
  constructor(private readonly webhook: MpWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'mercadoPagoWebhook',
    summary: 'Receive Mercado Pago order notifications (public, HMAC signed)',
    description: [
      'Public endpoint called by Mercado Pago when something happens to an `Order`. Authentication is the `x-signature` HMAC over `id:{data.id};request-id:{x-request-id};ts:{ts};`, plus a ±5 minute replay window.',
      '',
      'The body is **not** covered by that signature, so it is treated as a trigger only: the order status is re-read from `GET /v1/orders/{id}` and the payment intent transitions on that value, never on the `action` field of the payload.',
      '',
      'Answers `200` with an empty body for everything that is not a signature failure — unknown topics, unknown actions, orders that are not ours, and notifications that another process already handled — because any non-2xx makes Mercado Pago retry every 15 minutes.',
    ].join('\n'),
  })
  @ApiHeader({
    name: 'x-signature',
    required: true,
    description:
      'Mercado Pago signature, formatted as `ts=<ts>,v1=<hex hmac>`.',
  })
  @ApiHeader({
    name: 'x-request-id',
    required: false,
    description: 'Request id of the notification. Part of the signed manifest.',
  })
  @ApiQuery({
    name: 'data.id',
    required: false,
    description:
      'Id of the Mercado Pago order. The only event field the signature authenticates.',
  })
  @ApiOkResponse({
    description:
      'Notification acknowledged (processed, ignored, or already handled).',
  })
  @ApiUnauthorizedResponse({
    description:
      'The signature is missing, invalid, or its `ts` falls outside the replay window.',
    type: ProblemDetailsDto,
  })
  @ApiServiceUnavailableResponse({
    description:
      'The order could not be re-read from Mercado Pago (MP_WEBHOOK_ORDER_UNVERIFIED). Mercado Pago will retry.',
    type: ProblemDetailsDto,
  })
  async handle(@Req() req: Request): Promise<void> {
    await this.webhook.handle({
      signatureHeader: first(req.headers['x-signature']),
      requestId: first(req.headers['x-request-id']),
      // `data.id`, con el punto y todo: Express NO expande los puntos en claves
      // anidadas (`allowDots` viene apagado), así que la clave literal es la
      // correcta y `req.query.data?.id` no existiría.
      dataId: first(req.query['data.id']),
      rawBody: req.body,
    });
  }
}

/**
 * Un header o query param repetido llega como array. Se usa el primero: la
 * firma se calculó sobre un valor, no sobre una lista, y concatenarlos daría
 * un manifest que no valida nunca.
 */
function first(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const head: unknown = value[0];
    return typeof head === 'string' ? head : null;
  }
  return null;
}
