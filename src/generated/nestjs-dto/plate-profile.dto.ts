
import {ApiProperty} from '@nestjs/swagger'


export class PlateProfileDto {
  plate: string ;
vehicleBrand: string  | null;
vehicleModel: string  | null;
vehicleTypeId: string  | null;
vehicleTypeName: string  | null;
color: string  | null;
rateId: string  | null;
rateName: string  | null;
lastEntryId: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
lastEnteredAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
learnAfter: Date  | null;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
editVersion: number ;
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
deletedAt: Date  | null;
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
