
import {MpAccountStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class MpAccountDto {
  id: string ;
@ApiProperty({
  description: `Id del vendedor en Mercado Pago. NO es unique a propósito: un dueño con
varias playas tiene UNA sola cuenta de Mercado Pago y un solo CUIT, y las
separa con un Store/POS por playa, que es como Mercado Pago espera que se
haga. Un unique acá rompería el alta de la segunda playa a cambio de nada.`,
})
mpUserId: string ;
@ApiProperty({
  description: `CIFRADO, nunca en plano: el base64 que produce \'MpCryptoService\'
(AES-256-GCM, \'base64(iv[12] || tag[16] || ciphertext)\').`,
})
accessToken: string ;
@ApiProperty({
  description: `CIFRADO igual que \'accessToken\', y es el secreto de más valor de la fila:
con él se renueva el acceso sin volver a pedirle permiso al dueño.`,
})
refreshToken: string ;
@ApiProperty({
  description: `Versión de la clave que cifró los tokens DE ESTA FILA. Se cifra con la
clave activa y se descifra con la que diga la fila: es lo que hace posible
rotar la clave sin re-cifrar todo de golpe.`,
  type: `integer`,
  format: `int32`,
})
tokenKeyVersion: number ;
@ApiProperty({
  description: `Cuándo vence el \'accessToken\'. Es lo que ordena el barrido del cron.`,
  type: `string`,
  format: `date-time`,
})
accessTokenExpiresAt: Date ;
@ApiProperty({
  enum: MpAccountStatus,
})
status: MpAccountStatus ;
@ApiProperty({
  description: `Id del \'Store\' de Mercado Pago creado para esta playa.`,
})
storeId: string  | null;
@ApiProperty({
  description: `Id del \'POS\' de Mercado Pago: la caja contra la que se genera el QR.`,
})
posId: string  | null;
@ApiProperty({
  description: `NUESTRO identificador del POS (\'external_id\' del lado de Mercado Pago).`,
})
externalPosId: string  | null;
@ApiProperty({
  description: `Imagen del QR que devuelve la creación del POS.`,
})
qrImageUrl: string  | null;
@ApiProperty({
  description: `PDF imprimible del QR: el cartel que el dueño pega en el mostrador.`,
})
qrTemplateDocumentUrl: string  | null;
@ApiProperty({
  description: `Fallos CONSECUTIVOS del refresh. Contador y no flag: un 500 de Mercado
Pago no puede dejar a una playa sin cobrar. A los 3, el cron pasa \'status\'
a \'token_expired\'; un refresh exitoso lo vuelve a 0.`,
  type: `integer`,
  format: `int32`,
})
refreshFailureCount: number ;
@ApiProperty({
  description: `Último refresh EXITOSO. NULL mientras los tokens sean los originales.`,
  type: `string`,
  format: `date-time`,
})
lastRefreshAt: Date  | null;
@ApiProperty({
  description: `Cuándo se completó la vinculación. Separado de \'createdAt\' porque una
re-vinculación reescribe la fila.`,
  type: `string`,
  format: `date-time`,
})
linkedAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
}
