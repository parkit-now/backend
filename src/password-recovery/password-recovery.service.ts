import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from '../users/users.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { EMAIL_SENDER, type EmailSender } from './email/email-sender';

const RATE_LIMIT_WINDOW_MIN = 60;
const RATE_LIMIT_MAX_REQUESTS = 3;

@Injectable()
export class PasswordRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  private admin!: ReturnType<typeof createClient>;
  private anon!: ReturnType<typeof createClient>;
  private webPanelUrl!: string;
  private linkTtlMinutes!: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
  ) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = this.config.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');

    const stateless = { autoRefreshToken: false, persistSession: false };
    this.admin = createClient(url, serviceRoleKey, { auth: stateless });
    this.anon = createClient(url, anonKey, { auth: stateless });

    this.webPanelUrl = this.config.getOrThrow<string>('WEB_PANEL_URL');
    this.linkTtlMinutes = Number(
      this.config.get<string>('PASSWORD_RESET_LINK_TTL_MIN') ?? '30',
    );
  }

  async requestReset(email: string, ipAddress: string | null): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();

    if (await this.isRateLimited(normalizedEmail)) {
      await this.recordAudit(
        normalizedEmail,
        ipAddress,
        'ignored_rate_limited',
      );
      return;
    }

    const user = await this.users.findByEmail(normalizedEmail);
    if (!user) {
      await this.recordAudit(
        normalizedEmail,
        ipAddress,
        'ignored_unknown_email',
      );
      return;
    }

    let hashedToken: string | undefined;
    try {
      const redirectTo = `${this.webPanelUrl}/reset-password`;
      const { data, error } = await this.admin.auth.admin.generateLink({
        type: 'recovery',
        email: normalizedEmail,
        options: { redirectTo },
      });
      if (error || !data?.properties?.hashed_token) {
        this.logger.error(
          `generateLink failed for ${normalizedEmail}: ${error?.message ?? 'no token returned'}`,
        );
        await this.recordAudit(normalizedEmail, ipAddress, 'email_failed');
        return;
      }
      hashedToken = data.properties.hashed_token;
    } catch (err) {
      this.logger.error(`generateLink threw for ${normalizedEmail}`, err);
      await this.recordAudit(normalizedEmail, ipAddress, 'email_failed');
      return;
    }

    const resetUrl = `${this.webPanelUrl}/reset-password?token=${encodeURIComponent(hashedToken)}`;

    try {
      await this.emailSender.sendPasswordReset(
        normalizedEmail,
        resetUrl,
        this.linkTtlMinutes,
      );
      await this.recordAudit(normalizedEmail, ipAddress, 'sent');
    } catch (err) {
      this.logger.error(
        `Failed to send password reset email to ${normalizedEmail}`,
        err,
      );
      await this.recordAudit(normalizedEmail, ipAddress, 'email_failed');
    }
  }

  async confirmReset(token: string, newPassword: string): Promise<void> {
    const { data, error } = await this.anon.auth.verifyOtp({
      type: 'recovery',
      token_hash: token,
    });

    if (error || !data?.user) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Invalid or expired password reset token',
        '/auth/reset-password',
        ErrorCodes.AUTH_RESET_TOKEN_INVALID,
      );
    }

    const userId = data.user.id;
    const email = data.user.email?.toLowerCase();

    const { error: updateError } = await this.admin.auth.admin.updateUserById(
      userId,
      { password: newPassword },
    );

    if (updateError) {
      const code =
        updateError.code === 'weak_password'
          ? ErrorCodes.AUTH_WEAK_PASSWORD
          : ErrorCodes.AUTH_RESET_PASSWORD_FAILED;
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        updateError.message,
        '/auth/reset-password',
        code,
      );
    }

    if (email) {
      await this.markLastSentAsCompleted(email);
    }
  }

  private async isRateLimited(email: string): Promise<boolean> {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000);
    const count = await this.prisma.passwordResetRequest.count({
      where: {
        email,
        requestedAt: { gte: since },
        status: { in: ['sent', 'email_failed'] },
      },
    });
    return count >= RATE_LIMIT_MAX_REQUESTS;
  }

  private async recordAudit(
    email: string,
    ipAddress: string | null,
    status:
      | 'sent'
      | 'email_failed'
      | 'ignored_unknown_email'
      | 'ignored_rate_limited'
      | 'completed',
  ): Promise<void> {
    await this.prisma.passwordResetRequest.create({
      data: { email, ipAddress, status },
    });
  }

  private async markLastSentAsCompleted(email: string): Promise<void> {
    const last = await this.prisma.passwordResetRequest.findFirst({
      where: { email, status: 'sent' },
      orderBy: { requestedAt: 'desc' },
    });
    if (!last) return;
    await this.prisma.passwordResetRequest.update({
      where: { id: last.id },
      data: { status: 'completed', completedAt: new Date() },
    });
  }
}
