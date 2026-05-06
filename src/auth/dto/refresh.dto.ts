import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @ApiProperty({
    description:
      'Refresh token returned by `POST /auth/login` or `POST /auth/register`.',
    example: 'v1:eyJhbGciOi...REFRESH...',
  })
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
