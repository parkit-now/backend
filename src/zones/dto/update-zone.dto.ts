import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateZoneDto {
  @ApiProperty({
    description: 'New name for the zone.',
    required: false,
    example: 'Ground floor',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: 'New number of car spots for this zone.',
    required: false,
    example: 40,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  carSpots?: number;

  @ApiProperty({
    description: 'New number of motorcycle spots for this zone.',
    required: false,
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  motorcycleSpots?: number;

  @ApiProperty({
    description: 'New number of bicycle spots for this zone.',
    required: false,
    example: 6,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  bicycleSpots?: number;
}
