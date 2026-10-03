
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateDriverVehicleDto {
  @IsNotEmpty()
@IsString()
plate: string;
@IsOptional()
@IsString()
brand?: string;
@IsOptional()
@IsString()
model?: string;
}
