
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdatePlateProfileMutationDto {
  @IsOptional()
@IsString()
plate?: string;
}
