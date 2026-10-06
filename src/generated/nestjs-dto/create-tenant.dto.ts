
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateTenantDto {
  @IsNotEmpty()
@IsString()
name: string;
@IsOptional()
@IsString()
legalName?: string;
@IsOptional()
@IsString()
cuit?: string;
@IsOptional()
@IsString()
email?: string;
@IsOptional()
@IsString()
phone?: string;
@ApiProperty({
  description: `Dirección completa en una línea, para mostrar. Guarda la \'nomenclatura\'
que devuelve la API Georef. Es el campo de display y el que mantiene la
retrocompatibilidad; los datos para Mercado Pago viven en las columnas
separadas de abajo.`,
})
@IsOptional()
@IsString()
address?: string;
@IsOptional()
@IsString()
entryCameraId?: string;
@IsOptional()
@IsString()
entryCameraLabel?: string;
@ApiProperty({
  description: `Nombre de la calle, sin altura.`,
})
@IsOptional()
@IsString()
streetName?: string;
@ApiProperty({
  description: `Altura, como TEXTO y no entero a propósito: existen "S/N", "1234 bis" y
"Km 5". Mercado Pago también lo recibe como string. No convertir a Int.`,
})
@IsOptional()
@IsString()
streetNumber?: string;
@ApiProperty({
  description: `Piso y/o departamento. Sólo contacto/facturación; Mercado Pago no lo usa.`,
})
@IsOptional()
@IsString()
floor?: string;
@IsOptional()
@IsString()
cityName?: string;
@IsOptional()
@IsString()
stateName?: string;
@IsOptional()
@IsString()
postalCode?: string;
@ApiProperty({
  description: `Latitud en grados decimales. Sólo válida junto con \'longitude\': el CHECK
\'tenants_coordinates_paired\' prohíbe media coordenada.`,
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
latitude?: Prisma.Decimal;
@ApiProperty({
  description: `Longitud en grados decimales. Ver \'latitude\'.`,
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
longitude?: Prisma.Decimal;
@ApiProperty({
  description: `Origen del dato: \'georef\' (normalizado por la API del Estado) o \'manual\'.
Conjunto cerrado por el CHECK \'tenants_geocoding_source_valid\'.`,
})
@IsOptional()
@IsString()
geocodingSource?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
geocodedAt?: Date;
@ApiProperty({
  description: `NULL = vivo. Es el único campo que mira el backend para decidir si existe.`,
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
@ApiProperty({
  description: `Desde cuándo la purga puede borrarlo. Separado de \'deletedAt\' porque la
ventana es por borrado (\'graceDays\', 0..365), no una constante.`,
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
purgeAfter?: Date;
@IsOptional()
@IsString()
deletedReason?: string;
}
