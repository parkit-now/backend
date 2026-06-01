
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsString} from 'class-validator'




export class CreateAuditLogDto {
  @IsNotEmpty()
@IsString()
action: string;
@IsNotEmpty()
@IsString()
entityType: string;
@IsOptional()
@IsString()
entityId?: string;
}
