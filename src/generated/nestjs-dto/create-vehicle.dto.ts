import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateVehicleDto {
  @IsNotEmpty()
  @IsString()
  brand: string;
  @IsNotEmpty()
  @IsString()
  model: string;
  @IsOptional()
  @IsString()
  type?: string;
}
