import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSender } from './email-sender';
import { renderPasswordResetEmail } from './templates/password-reset.template';

/**
 * Gmail SMTP transport via nodemailer.
 *
 * Auth uses an App Password generated for the dedicated Gmail account
 * (`GMAIL_SMTP_USER`); 2FA must be enabled on that account for App
 * Passwords to be issuable.
 *
 * Swap-out path: implement another `EmailSender` (Resend, SES, etc.) and
 * change the `useClass` binding in `password-recovery.module.ts`.
 */
@Injectable()
export class GmailSmtpEmailSender implements EmailSender, OnModuleInit {
  private readonly logger = new Logger(GmailSmtpEmailSender.name);
  private transporter!: Transporter;
  private from!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const user = this.config.getOrThrow<string>('GMAIL_SMTP_USER');
    const pass = this.config.getOrThrow<string>('GMAIL_SMTP_APP_PASSWORD');
    this.from = this.config.getOrThrow<string>('EMAIL_FROM');

    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user, pass },
    });
  }

  async sendPasswordReset(
    to: string,
    resetUrl: string,
    ttlMinutes: number,
  ): Promise<void> {
    const { subject, html, text } = renderPasswordResetEmail({
      resetUrl,
      ttlMinutes,
    });

    await this.transporter.sendMail({
      from: this.from,
      to,
      subject,
      text,
      html,
    });

    this.logger.log(`Sent password reset email to ${to}`);
  }
}
