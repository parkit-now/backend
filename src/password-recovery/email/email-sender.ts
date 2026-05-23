/**
 * Outbound transactional email surface.
 *
 * Implementations live next to this file (one per provider). The service
 * layer depends on this interface only — to swap providers (Gmail SMTP →
 * Resend / SES / etc.) change the binding in `password-recovery.module.ts`
 * without touching call sites.
 */
export interface EmailSender {
  sendPasswordReset(
    to: string,
    resetUrl: string,
    ttlMinutes: number,
  ): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EmailSender');
