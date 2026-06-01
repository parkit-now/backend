
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateAuditLogDto {
  @IsOptional()
@IsString()
action?: string;
@IsOptional()
@IsString()
entityType?: string;
@IsOptional()
@IsString()
entityId?: string;
}
