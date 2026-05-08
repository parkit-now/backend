import { Type } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  nombre?: string;
}
