import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Registers a document's metadata. The binary is uploaded to Supabase Storage
 * from the client; here only the `storagePath` is stored.
 */
export class RegisterDocumentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Object key in Supabase Storage' })
  @IsString()
  @IsNotEmpty()
  storagePath: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  mimeType?: string;
}
