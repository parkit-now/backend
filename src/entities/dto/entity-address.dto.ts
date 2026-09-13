import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsDefined,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Quién produjo la dirección estructurada. Conjunto cerrado, espejo del CHECK
 * `tenants_geocoding_source_valid` (migración 20260913164617):
 *
 * - `georef`: normalizada por la API Georef del Estado argentino (el front la
 *   consulta y manda los campos ya separados).
 * - `manual`: la escribió una persona a mano porque Georef no resolvió.
 *
 * Sirve para decidir si se puede re-normalizar automáticamente sin pisar
 * trabajo humano. Agregar un valor nuevo es un cambio de comportamiento: va
 * por migración, no sólo acá.
 */
export const GEOCODING_SOURCES = ['georef', 'manual'] as const;

export type GeocodingSource = (typeof GEOCODING_SOURCES)[number];

/**
 * Dirección estructurada de la entidad (tenant), en columnas planas de
 * `tenants` (NO en `settings`).
 *
 * Existe porque Mercado Pago necesita la ubicación del `Store` con los campos
 * SEPARADOS (`street_name`, `street_number`, `city_name`, `state_name`,
 * `latitude`, `longitude`) para dar de alta el cobro con QR, y avisa
 * explícitamente que una ubicación mal cargada le rompe el cálculo de
 * impuestos al dueño del comercio.
 *
 * El backend NO geocodifica: no llama a Georef ni a ningún geocoder. Sólo
 * persiste lo que le mandan ya normalizado.
 *
 * Cada propiedad lleva su `@ApiProperty` explícito: el plugin CLI de
 * `@nestjs/swagger` NO está habilitado en este repo, así que una propiedad sin
 * decorar simplemente no existe en el contrato OpenAPI del que se generan los
 * tipos del front.
 */
export class EntityAddressDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Dirección completa en una línea, para mostrar. Es el espejo de la columna `address` (la `nomenclatura` que devuelve Georef). `null` si no se cargó.',
    example: 'Av. Corrientes 1234, Balvanera, CABA',
  })
  formatted: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre de la calle, sin altura.',
    example: 'Avenida Corrientes',
  })
  streetName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Altura de la calle. Es texto y NO un número a propósito: la numeración real incluye `S/N`, `1234 bis` y `Km 5`.',
    example: '1234',
  })
  streetNumber: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Piso y/o departamento. Sólo para contacto/facturación; Mercado Pago no lo usa en la ubicación del Store.',
    example: 'PB',
  })
  floor: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Localidad.',
    example: 'Balvanera',
  })
  cityName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Provincia (o Ciudad Autónoma de Buenos Aires).',
    example: 'Ciudad Autónoma de Buenos Aires',
  })
  stateName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Código postal.',
    example: 'C1043',
  })
  postalCode: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Latitud en grados decimales (hasta 6 decimales). Siempre viene junto con `longitude` o las dos en `null`: media coordenada está prohibida por el CHECK `tenants_coordinates_paired`.',
    example: -34.603722,
  })
  latitude: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Longitud en grados decimales (hasta 6 decimales). Ver `latitude`.',
    example: -58.381592,
  })
  longitude: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: GEOCODING_SOURCES,
    description:
      'Origen de la dirección estructurada: `georef` (normalizada por la API Georef del Estado) o `manual` (cargada a mano). `null` si nunca se cargó.',
    example: 'georef',
  })
  geocodingSource: GeocodingSource | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'Cuándo se normalizó/cargó la dirección estructurada (ISO-8601 UTC). `null` si nunca se cargó.',
    example: '2026-09-13T16:46:17.000Z',
  })
  geocodedAt: string | null;
}

/**
 * Escritura de la dirección estructurada. Todo opcional y nullable: mandar
 * `null` explícito BORRA el campo, omitirlo lo deja como está (semántica de
 * patch, igual que el resto del perfil).
 *
 * El par de coordenadas se manda completo o no se manda. La autoridad es el
 * CHECK `tenants_coordinates_paired`, pero acá se valida IGUAL con
 * `@ValidateIf` + `@IsDefined`, y no por redundancia: en Prisma 7 con
 * `@prisma/adapter-pg` una violación de CHECK llega como `DriverAdapterError`,
 * que NO es un `PrismaClientKnownRequestError` y por lo tanto el filter de
 * errores no lo mapea — el cliente se comería un 500 opaco en vez de un 400
 * que le diga qué campo le falta.
 *
 * Ninguno de estos campos es obligatorio para existir como tenant: la
 * obligatoriedad aparece recién al vincular Mercado Pago y la valida el
 * service de esa integración, no la base ni este DTO.
 */
export class UpdateEntityAddressDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Dirección completa en una línea (la `nomenclatura` de Georef). Se guarda en la columna `address`. Si se manda junto con el `address` plano del perfil, GANA este valor.',
    example: 'Av. Corrientes 1234, Balvanera, CABA',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  formatted?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Nombre de la calle, sin altura.',
    example: 'Avenida Corrientes',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  streetName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Altura de la calle. Texto, no número: `S/N`, `1234 bis` y `Km 5` son alturas válidas.',
    example: '1234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  streetNumber?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Piso y/o departamento.',
    example: 'PB',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  floor?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Localidad.',
    example: 'Balvanera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  cityName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Provincia (o Ciudad Autónoma de Buenos Aires).',
    example: 'Ciudad Autónoma de Buenos Aires',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  stateName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Código postal.',
    example: 'C1043',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  postalCode?: string | null;

  // Nota sobre el par: `@ValidateIf` corre los validadores de la propiedad
  // sólo si la condición da true. Con las dos ausentes/`null` se saltean las
  // dos (borrar el par es válido); con UNA sola cargada, la que falta entra a
  // validarse y `@IsDefined` la rechaza nombrando el campo. No se puede usar
  // `@IsOptional()` acá: corta la cadena cuando el valor es `null`, que es
  // justo el caso de media coordenada que hay que rechazar.
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Latitud en grados decimales, hasta 6 decimales (la columna es `numeric(9,6)`). Se manda junto con `longitude` o ninguna de las dos: media coordenada es un 400.',
    example: -34.603722,
  })
  @ValidateIf((o: UpdateEntityAddressDto) =>
    o.latitude !== undefined && o.latitude !== null
      ? true
      : o.longitude !== undefined && o.longitude !== null,
  )
  @IsDefined()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Longitud en grados decimales, hasta 6 decimales. Ver `latitude`.',
    example: -58.381592,
  })
  @ValidateIf((o: UpdateEntityAddressDto) =>
    o.longitude !== undefined && o.longitude !== null
      ? true
      : o.latitude !== undefined && o.latitude !== null,
  )
  @IsDefined()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: GEOCODING_SOURCES,
    description:
      'Origen del dato: `georef` si lo normalizó la API Georef, `manual` si lo escribió una persona.',
    example: 'georef',
  })
  @IsOptional()
  @IsIn(GEOCODING_SOURCES)
  geocodingSource?: GeocodingSource | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'Cuándo se normalizó/cargó la dirección (ISO-8601). Lo manda el cliente que normalizó.',
    example: '2026-09-13T16:46:17.000Z',
  })
  @IsOptional()
  @IsDateString()
  geocodedAt?: string | null;
}
