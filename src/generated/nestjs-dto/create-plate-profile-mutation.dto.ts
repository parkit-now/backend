
import {Type} from 'class-transformer'
import {IsNotEmpty,IsString} from 'class-validator'




export class CreatePlateProfileMutationDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
plate: string;
}
