import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../utils/pagination/pagination-query.dto';

/** Query for the admin parking-lot list: free-text search + pagination. */
export class ListParkingsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Case-insensitive search matched against the parking name and address. ' +
      'Powers both the inventory table and the membership autocomplete.',
    example: 'centro',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Incluir los estacionamientos dados de baja, para poder restaurarlos. ' +
      'Por defecto `false`: el inventario muestra sólo los vivos.',
    example: true,
  })
  // Llega por query string, así que es el texto 'true'/'false' y no un boolean.
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  includeDeleted?: boolean;
}
