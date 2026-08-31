import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Normaliza marca y modelo acá, en un solo lugar, para que create y update
 * coincidan con la expresión de `vehicles_scope_brand_model_uidx`
 * (`lower(btrim(...))`). El `btrim()` del índice queda de backstop: sin esto,
 * ' Toyota ' y 'Toyota' entrarían como la misma clave pero se guardarían
 * distinto, y la tabla mostraría espacios sueltos.
 */
export const normalizeVehicleText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class CreateVehicleDto {
  @ApiProperty({
    description: 'Client-generated UUIDv7 for offline-first sync.',
    format: 'uuid',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'Toyota', maxLength: 120 })
  @Transform(normalizeVehicleText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  brand: string;

  @ApiProperty({ example: 'Corolla', maxLength: 120 })
  @Transform(normalizeVehicleText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  model: string;

  @ApiPropertyOptional({ enum: VehicleType, example: VehicleType.auto })
  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;
}
