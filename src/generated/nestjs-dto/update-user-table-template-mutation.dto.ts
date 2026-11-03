
import {Type} from 'class-transformer'
import {IsOptional,IsString} from 'class-validator'




export class UpdateUserTableTemplateMutationDto {
  @IsOptional()
@IsString()
mutationId?: string;
@IsOptional()
@IsString()
target?: string;
}
