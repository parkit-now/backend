import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MpAccountStatus } from '@prisma/client';

/**
 * La cuenta de Mercado Pago de una playa, tal como la ve el panel.
 *
 * ## 🔴 Este DTO NO expone tokens. Nunca. Ni truncados.
 *
 * `mp_accounts` guarda `access_token` y `refresh_token` cifrados. Ninguno de
 * los dos aparece acá, ni en claro ni como ciphertext ni "los últimos cuatro
 * caracteres para que el dueño verifique". Motivos, en orden de gravedad:
 *
 *  1. El `refresh_token` es la llave para operar con la plata del dueño sin
 *     volver a pedirle permiso. Filtrarlo es peor que filtrar una contraseña:
 *     no tiene 2FA y dura meses.
 *  2. El ciphertext tampoco va: filtrarlo regala el material para atacar la
 *     clave offline, y encima invita a que un cliente lo guarde "por las
 *     dudas".
 *  3. Un prefijo/sufijo del token tampoco: reduce el espacio de búsqueda y no
 *     le sirve a nadie. Para saber si la cuenta anda está `status`.
 *
 * Por eso el mapper (`toMpAccountDto`) lista los campos UNO POR UNO en vez de
 * hacer spread del modelo de Prisma: con spread, agregar una columna al modelo
 * la publica sola, en silencio, en el próximo `db:generate`. Hay un test que
 * afirma justamente esto — ver `mp-accounts.service.spec.ts`.
 */
export class MpAccountDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Identifier of the linked Mercado Pago account row.',
    example: '9f1c2b3a-4d5e-4f6a-8b9c-0d1e2f3a4b5c',
  })
  id: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Entity (parking lot / tenant) that owns this linked account.',
    example: '11111111-1111-7111-8111-111111111111',
  })
  tenantId: string;

  @ApiProperty({
    description:
      'Seller identifier in Mercado Pago. NOT unique across entities: one owner with several parking lots has a single Mercado Pago account and separates lots by store/POS.',
    example: '446566691',
  })
  mpUserId: string;

  @ApiProperty({
    description:
      'Lifecycle of the link. `linked` is operational; `token_expired` needs the owner to re-authorize; `revoked` means the link was undone.',
    enum: MpAccountStatus,
    enumName: 'MpAccountStatus',
    example: MpAccountStatus.linked,
  })
  status: MpAccountStatus;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Mercado Pago `Store` identifier created for this entity.',
    example: '1234567',
  })
  storeId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Mercado Pago `POS` identifier: the till the QR code is generated against.',
    example: '2711382',
  })
  posId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Our own POS identifier (`external_id` on the Mercado Pago side).',
    example: 'parkit-11111111',
  })
  externalPosId: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'URL of the static QR image for this entity.',
    example:
      'https://www.mercadopago.com/instore/merchant/qr/2711382/abc123.png',
  })
  qrImageUrl: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'URL of the printable PDF carrying the QR code — the sign the owner puts on the counter.',
    example:
      'https://www.mercadopago.com/instore/merchant/qr/2711382/template_abc123.pdf',
  })
  qrTemplateDocumentUrl: string | null;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the current access token expires. Renewed by the refresh job; exposed so the panel can warn before it lapses.',
    example: '2026-09-14T01:00:00.000Z',
  })
  accessTokenExpiresAt: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'Consecutive refresh failures. A counter, not a flag: a single Mercado Pago 500 must not knock an entity offline.',
    example: 0,
  })
  refreshFailureCount: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Last SUCCESSFUL token refresh. Null while the tokens are still the original ones.',
    example: null,
  })
  lastRefreshAt: string | null;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the link was completed. Separate from `createdAt` because re-linking rewrites the row.',
    example: '2026-09-14T01:00:00.000Z',
  })
  linkedAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Row creation timestamp.',
    example: '2026-09-14T01:00:00.000Z',
  })
  createdAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Row last-update timestamp.',
    example: '2026-09-14T01:00:00.000Z',
  })
  updatedAt: string;
}
