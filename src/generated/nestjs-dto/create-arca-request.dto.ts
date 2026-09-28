
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsInt,IsNotEmpty,IsOptional,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateArcaRequestDto {
  @IsNotEmpty()
@IsString()
operation: string;
@IsOptional()
requestJson?: Prisma.InputJsonValue;
@IsOptional()
responseJson?: Prisma.InputJsonValue;
@IsOptional()
@IsString()
error?: string;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
@IsNotEmpty()
@IsInt()
durationMs: number;
}
