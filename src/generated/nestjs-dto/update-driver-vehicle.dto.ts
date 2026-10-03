
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateDriverVehicleDto {
  @IsOptional()
@IsString()
plate?: string;
@IsOptional()
@IsString()
kind?: string;
@IsOptional()
@IsString()
brand?: string;
@IsOptional()
@IsString()
model?: string;
}
