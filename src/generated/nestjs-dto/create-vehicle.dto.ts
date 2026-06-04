
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateVehicleDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsOptional()
@IsString()
plate?: string;
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
