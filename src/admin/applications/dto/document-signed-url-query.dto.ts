import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export type DocumentDisposition = 'inline' | 'attachment';

export class DocumentSignedUrlQueryDto {
  @ApiPropertyOptional({
    enum: ['inline', 'attachment'],
    description:
      'Content disposition for the signed URL. `inline` (default) lets the browser render the document (preview); `attachment` forces a download with the original file name.',
    example: 'inline',
  })
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: DocumentDisposition;
}
