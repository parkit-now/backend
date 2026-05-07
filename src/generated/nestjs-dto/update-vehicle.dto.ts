import { IsOptional, IsString } from 'class-validator';

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  brand?: string;
  @IsOptional()
  @IsString()
  model?: string;
  @IsOptional()
  @IsString()
  type?: string;
}
