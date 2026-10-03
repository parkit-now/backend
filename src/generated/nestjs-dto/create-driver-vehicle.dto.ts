
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateDriverVehicleDto {
  @IsNotEmpty()
@IsString()
plate: string;
@IsNotEmpty()
@IsString()
kind: string;
@IsOptional()
@IsString()
brand?: string;
@IsOptional()
@IsString()
model?: string;
}
