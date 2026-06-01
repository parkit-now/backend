import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/**
 * Manual DTO: the generator drops fields with `@default` (the spot counts), so
 * it cannot express this contract (see AGENTS §4 — manual when the generator
 * does not express the validation). `tenantId` is NOT part of the payload: it
 * is injected by the `prismaForTenant` extension.
 */
export class CreateZoneDto {
  @ApiProperty({
    description: 'Human-readable name of the zone within the parking lot.',
    example: 'Ground floor',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    description: 'Number of car spots configured for this zone.',
    required: false,
    default: 0,
    example: 40,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  carSpots?: number;

  @ApiProperty({
    description: 'Number of motorcycle spots configured for this zone.',
    required: false,
    default: 0,
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  motorcycleSpots?: number;

  @ApiProperty({
    description: 'Number of bicycle spots configured for this zone.',
    required: false,
    default: 0,
    example: 6,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  bicycleSpots?: number;
}
