import { ApiProperty } from '@nestjs/swagger';

/**
 * Short-lived signed URL the owner/operator frontend uses to preview an LPR
 * detection event photo directly from Supabase Storage.
 */
export class LprDetectionEventImageSignedUrlDto {
  @ApiProperty({
    description:
      'Time-limited signed URL pointing at the photo binary in Supabase Storage.',
    example:
      'https://project.supabase.co/storage/v1/object/sign/lpr-detection-images/3f2504e0/9c858901.jpg?token=...',
  })
  url: string;

  @ApiProperty({
    type: 'integer',
    description: 'Seconds the signed URL remains valid.',
    example: 300,
  })
  expiresIn: number;
}
