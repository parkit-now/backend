import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { normalizeCatalogText } from '../../utils/text/normalize-catalog-text';

export class UpdateVehicleTypeDto {
  @ApiPropertyOptional({ example: 'Utilitario', maxLength: 60 })
  @IsOptional()
  @Transform(normalizeCatalogText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  accepted?: boolean;
}
