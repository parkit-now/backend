import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { EMAIL_SENDER } from './email/email-sender';
import { GmailSmtpEmailSender } from './email/gmail-smtp-email-sender';
import { PasswordRecoveryController } from './password-recovery.controller';
import { PasswordRecoveryService } from './password-recovery.service';

/**
 * Password recovery module — emails a recovery link to the user and
 * confirms the new password via Supabase Auth.
 *
 * The email transport is injected via the `EMAIL_SENDER` token. To swap
 * providers (Gmail SMTP → Resend / SES / …), change the `useClass` below
 * without touching the service.
 */
@Module({
  imports: [UsersModule],
  controllers: [PasswordRecoveryController],
  providers: [
    PasswordRecoveryService,
    { provide: EMAIL_SENDER, useClass: GmailSmtpEmailSender },
  ],
})
export class PasswordRecoveryModule {}
