
import {Type} from 'class-transformer'
import {IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateMpOauthStateDto {
  @ApiProperty({
  description: `El \'code_verifier\' de PKCE (S256). Viaja a Mercado Pago sólo como hash
(\'code_challenge\') y se presenta en claro recién al canjear el código: sin
él, un \'authorization_code\' robado no se puede canjear.`,
})
@IsOptional()
@IsString()
codeVerifier?: string;
@ApiProperty({
  description: `A dónde volver en el front después del callback. Se guarda acá, y no en la
URL de retorno, para que el callback no acepte un destino arbitrario.`,
})
@IsOptional()
@IsString()
returnPath?: string;
@ApiProperty({
  description: `TTL de 10 minutos, el mismo que el \'authorization_code\' de Mercado Pago:
guardar el state más tiempo del que vive el código sólo agranda la ventana
de replay.`,
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
expiresAt?: Date;
@ApiProperty({
  description: `Cuándo se canjeó. NO es auditoría: es el candado de un solo uso. Se marca
en la MISMA transacción del canje, con un UPDATE condicional sobre
\'consumedAt IS NULL\'; si no actualizó ninguna fila, el callback es un
replay y se rechaza.`,
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
consumedAt?: Date;
}
