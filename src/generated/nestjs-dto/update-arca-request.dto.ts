
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsInt,IsOptional,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateArcaRequestDto {
  @IsOptional()
@IsString()
operation?: string;
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
@IsOptional()
@IsInt()
durationMs?: number;
}
