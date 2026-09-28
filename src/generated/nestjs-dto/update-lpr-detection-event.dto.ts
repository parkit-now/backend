
import {Prisma} from '@prisma/client'
import {Type} from 'class-transformer'
import {IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty} from '@nestjs/swagger'




export class UpdateLprDetectionEventDto {
  @IsOptional()
@IsString()
cameraId?: string;
@IsOptional()
@IsString()
location?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
firstSeenAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
lastSeenAt?: Date;
@IsOptional()
@IsString()
rawText?: string;
@IsOptional()
@IsString()
normalizedText?: string;
@IsOptional()
@IsString()
displayPlate?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
reviewedAt?: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
archivedAt?: Date;
@IsOptional()
@IsString()
imageStoragePath?: string;
@IsOptional()
@IsString()
imageUrl?: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsOptional()
@IsRFC3339()
imageDeletedAt?: Date;
@IsOptional()
@IsString()
bestCaptureId?: string;
@IsOptional()
plateBbox?: Prisma.InputJsonValue;
}
