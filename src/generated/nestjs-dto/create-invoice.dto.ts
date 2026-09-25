
import {Prisma,InvoiceStatus,ArcaEnvironment,ArcaTaxCondition} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsDecimal,IsIn,IsInt,IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateInvoiceDto {
  @ApiProperty({
  enum: InvoiceStatus,
})
@IsNotEmpty()
@IsIn(["not_required","pending","issuing","issued","error"])
status: InvoiceStatus;
@IsOptional()
@IsString()
errorCode?: string;
@IsOptional()
@IsString()
errorMessage?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
issuingStartedAt?: Date;
@ApiProperty({
  enum: ArcaEnvironment,
})
@IsOptional()
@IsIn(["homologacion","produccion"])
environment?: ArcaEnvironment;
@IsOptional()
@IsString()
emisorCuit?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
cbteTipo?: number;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
ptoVta?: number;
@ApiProperty({
  description: `Se guarda ANTES de llamar a ARCA para poder reconciliar si la llamada se
corta. Si ARCA rechaza, vuelve a null.`,
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
cbteNro?: number;
@IsOptional()
@IsString()
cae?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
caeVto?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
cbteFch?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
fchServDesde?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
fchServHasta?: Date;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
receptorDocTipo?: number;
@IsOptional()
@IsString()
receptorDocNro?: string;
@IsOptional()
@IsString()
receptorNombre?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsOptional()
@IsInt()
receptorCondicionIvaId?: number;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsNotEmpty()
@IsDecimal()
@Type(()=>String)
impTotal: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
impNeto?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
impIva?: Prisma.Decimal;
@ApiProperty({
  type: `number`,
  format: `double`,
})
@IsOptional()
@IsDecimal()
@Type(()=>String)
ivaRate?: Prisma.Decimal;
@IsOptional()
@IsString()
emisorRazonSocial?: string;
@IsOptional()
@IsString()
emisorDomicilio?: string;
@ApiProperty({
  enum: ArcaTaxCondition,
})
@IsOptional()
@IsIn(["responsable_inscripto","monotributo","exento"])
emisorCondicionIva?: ArcaTaxCondition;
@IsOptional()
@IsString()
emisorIibb?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
emisorInicioActividad?: Date;
@IsOptional()
@IsString()
issuedByUserId?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
issuedAt?: Date;
}
