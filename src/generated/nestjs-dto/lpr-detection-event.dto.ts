
import {Prisma,LprFormatType,LprQualityStatus,LprDetectionStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class LprDetectionEventDto {
  id: string ;
cameraId: string ;
location: string ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
firstSeenAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
lastSeenAt: Date ;
rawText: string  | null;
normalizedText: string  | null;
displayPlate: string  | null;
@ApiProperty({
  type: `number`,
  format: `float`,
})
confidence: number ;
formatValid: boolean ;
@ApiProperty({
  enum: LprFormatType,
})
formatType: LprFormatType ;
@ApiProperty({
  enum: LprQualityStatus,
})
qualityStatus: LprQualityStatus ;
@ApiProperty({
  enum: LprDetectionStatus,
})
status: LprDetectionStatus ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
reviewedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
archivedAt: Date  | null;
imageStoragePath: string  | null;
imageUrl: string  | null;
bestCaptureId: string  | null;
candidates: Prisma.JsonValue ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
version: number ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
syncSeq: number ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
}
