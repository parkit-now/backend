import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleOidcPayload extends JWTPayload {
  email?: string;
  email_verified?: boolean;
}

/**
 * Verifica los ID tokens (OIDC) que Google emite para una service account.
 * Es lo que manda Cloud Scheduler en `Authorization: Bearer` cuando el job se
 * crea con `--oidc-service-account-email`.
 *
 * Chequea firma (JWKS de Google, que `jose` cachea y rota solo), emisor,
 * vencimiento y que el token haya sido emitido para `audience`.
 */
@Injectable()
export class GoogleOidcService {
  private readonly jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

  async verify(token: string, audience: string): Promise<GoogleOidcPayload> {
    const { payload } = await jwtVerify<GoogleOidcPayload>(token, this.jwks, {
      issuer: GOOGLE_ISSUERS,
      audience,
      algorithms: ['RS256'],
    });
    return payload;
  }
}
