
import {ApiProperty} from '@nestjs/swagger'


export class ApplicationDocumentDto {
  id: string ;
name: string ;
storagePath: string ;
mimeType: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
}
