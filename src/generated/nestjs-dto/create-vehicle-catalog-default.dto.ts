
import {Type} from 'class-transformer'
import {IsNotEmpty,IsString} from 'class-validator'




export class CreateVehicleCatalogDefaultDto {
  @IsNotEmpty()
@IsString()
brand: string;
@IsNotEmpty()
@IsString()
model: string;
}
