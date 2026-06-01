
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateCompanyDto {
  @IsNotEmpty()
@IsString()
legalName: string;
@IsNotEmpty()
@IsString()
cuit: string;
@IsNotEmpty()
@IsString()
email: string;
@IsOptional()
@IsString()
phone?: string;
@IsOptional()
@IsString()
address?: string;
}
