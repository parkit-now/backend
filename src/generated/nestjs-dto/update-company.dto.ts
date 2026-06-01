
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateCompanyDto {
  @IsOptional()
@IsString()
legalName?: string;
@IsOptional()
@IsString()
cuit?: string;
@IsOptional()
@IsString()
email?: string;
@IsOptional()
@IsString()
phone?: string;
@IsOptional()
@IsString()
address?: string;
}
