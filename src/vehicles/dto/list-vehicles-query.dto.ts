import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export enum VehicleScope {
  all = 'all',
  tenant = 'tenant',
  global = 'global',
}

export class ListVehiclesQueryDto {
  @ApiPropertyOptional({
    enum: VehicleScope,
    default: VehicleScope.all,
    description:
      'all = globales + los de este estacionamiento (default); ' +
      'tenant = solo los propios, que son los únicos editables; ' +
      'global = solo los admin-managed, read-only.',
  })
  @IsOptional()
  @IsEnum(VehicleScope)
  scope: VehicleScope = VehicleScope.all;
}
