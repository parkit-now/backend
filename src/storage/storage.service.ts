import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';

/** Private bucket holding onboarding application documents (binaries). */
export const APPLICATION_DOCUMENTS_BUCKET = 'application-documents';

interface SignedUrlOptions {
  /**
   * When set, the signed URL is served with
   * `Content-Disposition: attachment; filename="<download>"`, forcing a
   * download instead of inline rendering.
   */
  download?: string;
}

/**
 * Thin wrapper around Supabase Storage using the SERVICE-ROLE key. It bypasses
 * Storage RLS, so PARKIT Ops (admin) can mint signed URLs for documents owned by
 * any applicant — the per-user bucket policies only authorize the owner's own
 * objects (see `add_application_documents_bucket` migration). This client is
 * intentionally separate from `SupabaseAuthService`'s private admin client.
 *
 * NEVER expose this client (or its raw service-role key) through public
 * endpoints; consume it only behind admin-guarded controllers.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client!: ReturnType<typeof createClient>;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = this.config.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Mints a short-lived signed URL for a private object. The browser then
   * downloads the binary straight from Supabase Storage with this link.
   */
  async createSignedUrl(
    bucket: string,
    path: string,
    expiresIn: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn, options);

    if (error || !data?.signedUrl) {
      this.logger.error(
        `Failed to create signed URL for ${bucket}/${path}`,
        error?.message,
      );
      throw new FormattedException(
        'Bad Gateway',
        HttpStatus.BAD_GATEWAY,
        error?.message ?? 'Failed to create signed URL',
        '/admin/applications',
        ErrorCodes.STORAGE_SIGNED_URL_FAILED,
      );
    }

    return data.signedUrl;
  }
}
