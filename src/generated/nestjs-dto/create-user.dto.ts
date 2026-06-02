
import {UserRole} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsIn,IsNotEmpty,IsOptional,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateUserDto {
  @IsNotEmpty()
@IsString()
id: string;
@ApiProperty({
  enum: UserRole,
})
@IsNotEmpty()
@IsIn(["admin","user"])
role: UserRole;
@IsNotEmpty()
@IsString()
email: string;
@IsOptional()
@IsString()
name?: string;
}
