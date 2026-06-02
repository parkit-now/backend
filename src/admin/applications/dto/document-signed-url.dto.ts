import { ApiProperty } from '@nestjs/swagger';

/**
 * Short-lived signed URL the admin frontend uses to preview or download an
 * application document directly from Supabase Storage.
 */
export class DocumentSignedUrlDto {
  @ApiProperty({
    description:
      'Time-limited signed URL pointing at the document binary in Supabase Storage.',
    example:
      'https://project.supabase.co/storage/v1/object/sign/application-documents/applications/3f2504e0/docs/habilitacion.pdf?token=...',
  })
  url: string;

  @ApiProperty({
    type: 'integer',
    description: 'Seconds the signed URL remains valid.',
    example: 300,
  })
  expiresIn: number;
}
