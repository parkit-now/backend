import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { UsersService } from '../users/users.service';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { MeResponseDto } from './dto/me-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthSessionResponseDto, SessionDto } from './dto/session.dto';
import { SupabaseAuthService } from './supabase-auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@ApiTags('Auth')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  AuthSessionResponseDto,
  SessionDto,
  MeResponseDto,
)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: SupabaseAuthService,
    private readonly users: UsersService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'authRegister',
    summary: 'Register a new user and return a session',
    description: [
      'Creates a Supabase Auth user, the matching row in `public.users`, then signs the user in and returns the tokens.',
      '',
      '**No role is accepted.** Every self-registered user gets the GLOBAL role `user`. Platform admins are provisioned out-of-band.',
      '',
      '**No tenant is attached at register.** A tenant equals a parking lot, and the new user has zero memberships. Applicants gain an `owner` membership when their onboarding application is approved; operators are linked to lots via invitations.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: AuthSessionResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid payload (validation, weak password, etc.).',
    type: ValidationProblemDetailsDto,
  })
  @ApiConflictResponse({
    description: 'A user with this email already exists.',
    type: ProblemDetailsDto,
  })
  async register(@Body() body: RegisterDto): Promise<AuthSessionResponseDto> {
    const { user, session } = await this.auth.register(body);
    return { user: this.users.toResponse(user), session };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    operationId: 'authMe',
    summary: 'Current user identity and entity memberships',
    description: [
      'Returns the authenticated caller: id, email, GLOBAL role (`admin | user`) and the list of entities (tenants) they belong to, each with the per-entity role (`owner | operator`).',
      '',
      'This is how clients discover which lots a `user` can act on and whether they manage (`owner`) or only operate (`operator`) — the entity role is NOT carried in the JWT. Admins return an empty `memberships` array (they bypass membership).',
    ].join('\n'),
  })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  me(@CurrentUser() user: User): Promise<MeResponseDto> {
    return this.users.getMe(user);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'authLogin',
    summary: 'Exchange email + password for a session (email/password only)',
    description: [
      'Calls Supabase Auth `signInWithPassword`.',
      '',
      '**This endpoint is only for email/password login.** Social OAuth (Google/GitHub) is started client-side via Supabase SDK and does NOT call `POST /auth/login`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiUnauthorizedResponse({
    description: 'Email not found or password mismatch.',
    type: ProblemDetailsDto,
  })
  login(@Body() body: LoginDto): Promise<SessionDto> {
    return this.auth.login(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'authRefresh',
    summary: 'Rotate a refresh token into a new session',
    description:
      'Calls Supabase Auth `refreshSession`. With refresh-token rotation enabled (default), the old `refreshToken` is single-use — store the new one returned here.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token is invalid, expired, or already used.',
    type: ProblemDetailsDto,
  })
  refresh(@Body() body: RefreshDto): Promise<SessionDto> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    operationId: 'authLogout',
    summary: 'Revoke the current session',
    description: [
      'Revokes the refresh token bound to the bearer access token, so it can no longer be used to obtain new sessions.',
      '',
      "**Note:** the access token itself stays valid until its short TTL expires — Supabase Auth doesn't blacklist JWTs. Clients should drop it locally on logout.",
    ].join('\n'),
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  async logout(@Req() request: Request): Promise<void> {
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    await this.auth.logout(token);
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [type, value] = header.split(' ');
    if (type !== 'Bearer' || !value) return null;
    return value;
  }
}
