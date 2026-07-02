
import {Type} from 'class-transformer'
import {IsNotEmpty,IsOptional,IsRFC3339,IsString} from 'class-validator'
import {ApiProperty,getSchemaPath} from '@nestjs/swagger'




export class CreateLprDetectionEventDto {
  @IsNotEmpty()
@IsString()
id: string;
@IsNotEmpty()
@IsString()
cameraId: string;
@IsNotEmpty()
@IsString()
location: string;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
firstSeenAt: Date;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
@IsNotEmpty()
@IsRFC3339()
lastSeenAt: Date;
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
@IsOptional()
@IsString()
bestCaptureId?: string;
}
