
import {Type} from 'class-transformer'
import {IsNotEmpty,IsString} from 'class-validator'




export class CreateUserTableTemplateMutationDto {
  @IsNotEmpty()
@IsString()
mutationId: string;
@IsNotEmpty()
@IsString()
target: string;
}
