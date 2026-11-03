
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateUserTableTemplateDto {
  @IsOptional()
@IsString()
platform?: string;
@IsOptional()
@IsString()
contextKey?: string;
@IsOptional()
@IsString()
tableKey?: string;
@IsOptional()
@IsString()
id?: string;
@IsOptional()
@IsString()
name?: string;
@IsOptional()
@IsString()
description?: string;
@IsOptional()
config?: Prisma.InputJsonValue;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
deletedAt?: Date;
}
