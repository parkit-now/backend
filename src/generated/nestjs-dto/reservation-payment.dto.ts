
import {Prisma,ReservationPaymentStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class ReservationPaymentDto {
  id: string ;
@ApiProperty({
  type: `number`,
  format: `double`,
})
amountArs: Prisma.Decimal ;
@ApiProperty({
  enum: ReservationPaymentStatus,
})
status: ReservationPaymentStatus ;
provider: string ;
providerPreferenceId: string  | null;
checkoutUrl: string  | null;
providerPaymentId: string  | null;
@ApiProperty({
  description: `Estado CRUDO del proveedor. String y no enum: puede sumar valores.`,
})
providerStatus: string  | null;
providerStatusDetail: string  | null;
returnUrl: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
approvedAt: Date  | null;
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
