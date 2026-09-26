import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArcaAccountStatus,
  ArcaEnvironment,
  ArcaTaxCondition,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * La cuenta de ARCA de una playa. NUNCA trae la clave privada, ni cifrada;
 * el certificado tampoco: sólo lo que el dueño necesita ver.
 */
export class ArcaAccountDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: ArcaAccountStatus,
    enumName: 'ArcaAccountStatus',
    description: [
      'Paso de la vinculación en el que está la playa:',
      '- `pending_certificate`: se generó la solicitud (CSR), falta subir el certificado.',
      '- `pending_sales_point`: certificado verificado, falta el punto de venta (y, en homologación, puede faltar cargar los datos fiscales: `condicionIva` en null).',
      '- `linked`: vinculada, emite.',
      '- `cert_expired`: venció el certificado; no emite hasta renovarlo (`account/renewal/*`).',
      'Una cuenta desvinculada responde 404 ARCA_NOT_LINKED.',
    ].join('\n'),
  })
  status: ArcaAccountStatus;

  @ApiProperty({ enum: ArcaEnvironment, enumName: 'ArcaEnvironment' })
  environment: ArcaEnvironment;

  @ApiProperty({
    example: '20123456783',
    description: '11 dígitos, sin guiones.',
  })
  cuit: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  iibb: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  razonSocial: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: ArcaTaxCondition,
    enumName: 'ArcaTaxCondition',
    description:
      'Decide la letra: monotributo y exento emiten C; responsable inscripto, A o B.',
  })
  condicionIva: ArcaTaxCondition | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  domicilioFiscal: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date',
    description: 'AAAA-MM-DD.',
  })
  inicioActividad: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  ptoVta: number | null;

  @ApiProperty({
    example: 21,
    description: 'Alícuota de IVA (%). Sólo aplica a responsables inscriptos.',
  })
  ivaRate: number;

  @ApiProperty({
    example: 'parkit1a2b3c4d',
    description:
      'Alias del certificado: el «Nombre simbólico del DN» a usar en WSASS o en Certificados Digitales.',
  })
  certAlias: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  certExpiresAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Cuándo se preparó la solicitud de renovación del certificado (null si no hay una en curso).',
  })
  renewalPreparedAt: string | null;

  @ApiProperty({
    description:
      'Si los datos fiscales se pueden cargar a mano (sólo homologación, donde el padrón no tiene los CUIT reales).',
  })
  fiscalDataEditable: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  linkedAt: string | null;
}

export class CreateArcaAccountDto {
  @ApiProperty({
    example: '20-12345678-3',
    description: 'Con o sin guiones. Se valida el dígito verificador.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  cuit: string;

  @ApiPropertyOptional({ example: '901-123456-7' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  iibb?: string;
}

export class ArcaCsrDto {
  @ApiProperty({ example: 'parkit1a2b3c4d.csr' })
  fileName: string;

  @ApiProperty({ example: 'parkit1a2b3c4d' })
  alias: string;

  @ApiProperty({
    description: 'PEM completo, con las líneas BEGIN/END CERTIFICATE REQUEST.',
  })
  csrPem: string;
}

export class UploadArcaCertificateDto {
  @ApiProperty({
    description:
      'Contenido del `.crt` que devolvió ARCA (PEM, con las líneas BEGIN/END CERTIFICATE).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  certificate: string;
}

export class ArcaCertificateResultDto {
  @ApiProperty({ type: ArcaAccountDto })
  account: ArcaAccountDto;

  @ApiProperty({
    description:
      'Si el padrón devolvió los datos fiscales. En homologación suele ser false: hay que cargarlos con PATCH.',
  })
  padronFound: boolean;
}

export class UpdateArcaAccountDto {
  @ApiPropertyOptional({ example: 21, minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  ivaRate?: number;

  @ApiPropertyOptional({
    description: 'Sólo homologación (`fiscalDataEditable`).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  razonSocial?: string;

  @ApiPropertyOptional({
    enum: ArcaTaxCondition,
    enumName: 'ArcaTaxCondition',
    description: 'Sólo homologación (`fiscalDataEditable`).',
  })
  @IsOptional()
  @IsEnum(ArcaTaxCondition)
  condicionIva?: ArcaTaxCondition;

  @ApiPropertyOptional({
    description: 'Sólo homologación (`fiscalDataEditable`).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  domicilioFiscal?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2020-01-01',
    description: 'Va impresa en la factura. Editable en cualquier entorno.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  inicioActividad?: string;
}

export class SetArcaSalesPointDto {
  @ApiProperty({ example: 3, minimum: 1, maximum: 99998 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99998)
  ptoVta: number;
}

export class ReuseArcaCertificateDto {
  @ApiProperty({
    format: 'uuid',
    description: 'La otra playa del mismo dueño, ya vinculada con este CUIT.',
  })
  @IsUUID()
  fromTenantId: string;
}

export class ArcaReusableCertificateDto {
  @ApiProperty({ format: 'uuid' })
  tenantId: string;

  @ApiProperty()
  tenantName: string;

  @ApiProperty()
  cuit: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  razonSocial: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  certExpiresAt: string | null;
}
