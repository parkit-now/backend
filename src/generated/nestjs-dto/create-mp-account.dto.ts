
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateMpAccountDto {
  @ApiProperty({
  description: `Id del vendedor en Mercado Pago. NO es unique a propósito: un dueño con
varias playas tiene UNA sola cuenta de Mercado Pago y un solo CUIT, y las
separa con un Store/POS por playa, que es como Mercado Pago espera que se
haga. Un unique acá rompería el alta de la segunda playa a cambio de nada.`,
})
@IsNotEmpty()
@IsString()
mpUserId: string;
@ApiProperty({
  description: `CIFRADO, nunca en plano: el base64 que produce \'MpCryptoService\'
(AES-256-GCM, \'base64(iv[12] || tag[16] || ciphertext)\').`,
})
@IsNotEmpty()
@IsString()
accessToken: string;
@ApiProperty({
  description: `CIFRADO igual que \'accessToken\', y es el secreto de más valor de la fila:
con él se renueva el acceso sin volver a pedirle permiso al dueño.`,
})
@IsNotEmpty()
@IsString()
refreshToken: string;
@ApiProperty({
  description: `Cuándo vence el \'accessToken\'. Es lo que ordena el barrido del cron.`,
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
accessTokenExpiresAt: Date;
@ApiProperty({
  description: `Id del \'Store\' de Mercado Pago creado para esta playa.`,
})
@IsOptional()
@IsString()
storeId?: string;
@ApiProperty({
  description: `Id del \'POS\' de Mercado Pago: la caja contra la que se genera el QR.`,
})
@IsOptional()
@IsString()
posId?: string;
@ApiProperty({
  description: `NUESTRO identificador del POS (\'external_id\' del lado de Mercado Pago).`,
})
@IsOptional()
@IsString()
externalPosId?: string;
@ApiProperty({
  description: `Imagen del QR que devuelve la creación del POS.`,
})
@IsOptional()
@IsString()
qrImageUrl?: string;
@ApiProperty({
  description: `PDF imprimible del QR: el cartel que el dueño pega en el mostrador.`,
})
@IsOptional()
@IsString()
qrTemplateDocumentUrl?: string;
@ApiProperty({
  description: `Último refresh EXITOSO. NULL mientras los tokens sean los originales.`,
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
lastRefreshAt?: Date;
}
