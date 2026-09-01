
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateVehicleCatalogDefaultDto {
  @IsOptional()
@IsString()
brand?: string;
@IsOptional()
@IsString()
model?: string;
}
