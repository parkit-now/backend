
import {ApiProperty} from '@nestjs/swagger'
import {TenantEntity} from './tenant.entity'
import {UserEntity} from './user.entity'


export class MpOauthStateEntity {
  @ApiProperty({
  description: `El parámetro \'state\' del OAuth, uuid v4 de \'randomUUID()\'. Sin \'@default\'
a propósito: lo genera el backend, no la base. Tiene que ser imposible de
adivinar: es lo único que ata el callback al flujo que lo inició.`,
})
state: string ;
@ApiProperty({
  description: `La playa que inició la vinculación. NO viene del callback: se guarda al
arrancar el flujo y es la única fuente de verdad de a qué playa vincular.`,
})
tenantId: string ;
tenant?: TenantEntity ;
@ApiProperty({
  description: `Quién inició la vinculación: para auditar y para re-chequear al volver que
siga teniendo permiso sobre la playa.`,
})
userId: string ;
user?: UserEntity ;
@ApiProperty({
  description: `El \'code_verifier\' de PKCE (S256). Viaja a Mercado Pago sólo como hash
(\'code_challenge\') y se presenta en claro recién al canjear el código: sin
él, un \'authorization_code\' robado no se puede canjear.`,
})
codeVerifier: string ;
@ApiProperty({
  description: `A dónde volver en el front después del callback. Se guarda acá, y no en la
URL de retorno, para que el callback no acepte un destino arbitrario.`,
})
returnPath: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  description: `TTL de 10 minutos, el mismo que el \'authorization_code\' de Mercado Pago:
guardar el state más tiempo del que vive el código sólo agranda la ventana
de replay.`,
  type: `string`,
  format: `date-time`,
})
expiresAt: Date ;
@ApiProperty({
  description: `Cuándo se canjeó. NO es auditoría: es el candado de un solo uso. Se marca
en la MISMA transacción del canje, con un UPDATE condicional sobre
\'consumedAt IS NULL\'; si no actualizó ninguna fila, el callback es un
replay y se rechaza.`,
  type: `string`,
  format: `date-time`,
})
consumedAt: Date  | null;
}
