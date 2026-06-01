
import {Type} from 'class-transformer'
import {IsNotEmpty,IsString} from 'class-validator'




export class CreateZoneDto {
  @IsNotEmpty()
@IsString()
name: string;
}
