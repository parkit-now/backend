
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateApplicationDocumentDto {
  @IsOptional()
@IsString()
name?: string;
@IsOptional()
@IsString()
storagePath?: string;
@IsOptional()
@IsString()
mimeType?: string;
}
