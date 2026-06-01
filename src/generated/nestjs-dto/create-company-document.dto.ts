
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateCompanyDocumentDto {
  @IsNotEmpty()
@IsString()
name: string;
@IsNotEmpty()
@IsString()
storagePath: string;
@IsOptional()
@IsString()
mimeType?: string;
}
