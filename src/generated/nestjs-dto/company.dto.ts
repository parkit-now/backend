
import {CompanyStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class CompanyDto {
  id: string ;
legalName: string ;
cuit: string ;
email: string ;
phone: string  | null;
address: string  | null;
@ApiProperty({
  enum: CompanyStatus,
})
status: CompanyStatus ;
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
