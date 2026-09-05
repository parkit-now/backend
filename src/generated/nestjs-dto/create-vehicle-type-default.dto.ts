
import {Type} from 'class-transformer'
import {IsNotEmpty,IsString} from 'class-validator'




export class CreateVehicleTypeDefaultDto {
  @IsNotEmpty()
@IsString()
name: string;
}
