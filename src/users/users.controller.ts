import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserDto } from '../generated/nestjs-dto/user.dto';
import { ProblemDetailsDto } from '../utils/exceptions/dto/problem-details.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiExtraModels(ProblemDetailsDto, UserDto)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    operationId: 'usersMe',
    summary: 'Get the currently authenticated user',
    description: [
      'Returns the public projection of the user identified by the `sub` claim of the Supabase bearer token.',
      '',
      '**Behavior:**',
      '- Reads the user from the database on every call — the response is always fresh, not just the JWT claims. A role change is reflected immediately even on previously issued tokens.',
      '- If the Supabase Auth user has no row in our `users` table the request is rejected `401 Unauthorized` (the user has not been provisioned by an admin yet).',
      '',
      '**Auth required:** valid `Authorization: Bearer <jwt>` header. The token must be a Supabase access token, signed with the project `SUPABASE_JWT_SECRET`.',
    ].join('\n'),
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The authenticated user.',
    type: UserDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'Bearer token is missing, malformed, expired, or the user is not provisioned.',
    type: ProblemDetailsDto,
    schema: {
      examples: {
        missing: {
          summary: 'No Authorization header',
          value: {
            title: 'Unauthorized',
            status: 401,
            detail: 'Missing bearer token',
            instance: '/users/me',
          },
        },
        invalid: {
          summary: 'Invalid or expired token',
          value: {
            title: 'Unauthorized',
            status: 401,
            detail: 'Invalid or expired token',
            instance: '/users/me',
          },
        },
        notProvisioned: {
          summary: 'Auth user has no row in users table',
          value: {
            title: 'Unauthorized',
            status: 401,
            detail: 'User not provisioned',
            instance: '/users/me',
          },
        },
      },
    },
  })
  me(@CurrentUser() current: User): UserDto {
    return this.usersService.toResponse(current);
  }
}
