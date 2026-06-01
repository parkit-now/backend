
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateTenantDto {
  @IsNotEmpty()
@IsString()
name: string;
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
