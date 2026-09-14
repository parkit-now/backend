import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { MpAccountDto } from './mp-account.dto';

/** Techo de largo del `code`. Los de MP rondan los 40 chars; 512 es holgado. */
const MAX_AUTHORIZATION_CODE_LENGTH = 512;

/**
 * Body de `POST /mercado-pago/oauth/callback`.
 *
 * Son los dos parámetros que Mercado Pago devuelve en el redirect, relevados
 * por el front. NADA más viaja acá: la playa, el usuario y el `code_verifier`
 * salen de la fila de `mp_oauth_states` que apunta el `state`, que es lo que
 * hace que un callback no pueda elegir a qué playa vincular.
 */
export class MpOauthCallbackDto {
  @ApiProperty({
    description:
      'The `authorization_code` Mercado Pago returned in the redirect. Single-use and valid for 10 minutes.',
    maxLength: MAX_AUTHORIZATION_CODE_LENGTH,
    example: 'TG-1a2b3c4d5e6f7a8b9c0d1e2f-241983636',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_AUTHORIZATION_CODE_LENGTH)
  code: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The `state` issued when the flow started. Single-use: it is consumed atomically, so a replayed callback is rejected.',
    example: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
  })
  @IsUUID()
  state: string;
}

/** Resultado del callback: la cuenta ya vinculada y a dónde volver. */
export class MpOauthCallbackResultDto {
  @ApiProperty({
    description:
      'The freshly linked Mercado Pago account. Never carries tokens.',
    type: MpAccountDto,
  })
  account: MpAccountDto;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Internal panel route the flow started from, validated when it was stored. Null when the caller did not ask for one.',
    example: '/configuracion/cobros',
  })
  returnPath: string | null;
}
