
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateUserTableTemplateDto {
  @IsNotEmpty()
@IsString()
platform: string;
@IsNotEmpty()
@IsString()
contextKey: string;
@IsNotEmpty()
@IsString()
tableKey: string;
@IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
name: string;
@IsOptional()
@IsString()
description?: string;
@IsNotEmpty()
config: Prisma.InputJsonValue;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
