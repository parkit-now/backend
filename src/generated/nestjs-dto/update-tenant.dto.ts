
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateTenantDto {
  @IsOptional()
@IsString()
name?: string;
@IsOptional()
@IsString()
address?: string;
}
