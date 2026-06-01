
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateZoneDto {
  @IsOptional()
@IsString()
name?: string;
}
