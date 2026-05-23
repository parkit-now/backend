import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordRecoveryService } from './password-recovery.service';

@ApiTags('Auth')
@ApiExtraModels(ProblemDetailsDto, ValidationProblemDetailsDto)
@Controller('auth')
export class PasswordRecoveryController {
  constructor(private readonly service: PasswordRecoveryService) {}

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'authForgotPassword',
    summary: 'Start a password reset flow by emailing a recovery link',
    description: [
      'Always responds with 204 No Content, regardless of whether the email is registered, to prevent account enumeration.',
      '',
      'When the email matches a registered user, a recovery link is generated via Supabase Auth and emailed to the user. The link redirects to the web panel `/reset-password` route carrying a single-use, short-lived token.',
      '',
      'Rate-limited internally to 3 attempts per email per hour. Beyond that, the request is silently ignored.',
    ].join('\n'),
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description: 'Invalid payload (e.g. malformed email).',
    type: ValidationProblemDetailsDto,
  })
  async forgotPassword(
    @Body() body: ForgotPasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    const ip = this.extractIp(request);
    await this.service.requestReset(body.email, ip);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'authResetPassword',
    summary: 'Set a new password using a recovery token',
    description: [
      'Validates the recovery token (issued by Supabase Auth) and replaces the user password if valid.',
      '',
      'The token is single-use and short-lived; once consumed it cannot be reused.',
    ].join('\n'),
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      'Token missing/invalid/expired, password too weak, or payload invalid.',
    type: ProblemDetailsDto,
  })
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.service.confirmReset(body.token, body.password);
  }

  private extractIp(request: Request): string | null {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return request.ip ?? null;
  }
}
