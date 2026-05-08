import { ApiProperty } from '@nestjs/swagger';
import { UserDto } from '../../generated/nestjs-dto/user.dto';

/**
 * Tokens returned by login / refresh / register. Mirrors the relevant fields
 * of a Supabase Auth session — renamed to camelCase to match this API's
 * convention.
 */
export class SessionDto {
  @ApiProperty({
    description:
      'Short-lived JWT to put in `Authorization: Bearer <accessToken>` on every protected call.',
  })
  accessToken: string;

  @ApiProperty({
    description:
      'Long-lived token used by `POST /auth/refresh` to obtain a fresh `accessToken`.',
  })
  refreshToken: string;

  @ApiProperty({
    description: 'Token type. Always `bearer`.',
    example: 'bearer',
  })
  tokenType: string;

  @ApiProperty({
    description: 'Lifetime of the access token, in seconds.',
    example: 3600,
    type: 'integer',
  })
  expiresIn: number;

  @ApiProperty({
    description: 'Unix timestamp (seconds) at which the access token expires.',
    example: 1735689600,
    type: 'integer',
  })
  expiresAt: number;
}

export class AuthSessionResponseDto {
  @ApiProperty({
    description: 'The authenticated user.',
    type: UserDto,
  })
  user: UserDto;

  @ApiProperty({
    description: 'Tokens to use for subsequent calls.',
    type: SessionDto,
  })
  session: SessionDto;
}
