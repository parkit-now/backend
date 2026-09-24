import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AesGcmDecryptError,
  aesGcmDecrypt,
  aesGcmEncrypt,
  type AesGcmEncrypted,
} from '../utils/crypto/aes-gcm';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpConfigService } from './mp-config.service';

/** Ruta lógica para el campo `instance` de los ProblemDetails. */
const INSTANCE = '/mercado-pago/tokens';

/** Resultado de cifrar: lo que va a las dos columnas de `mp_accounts`. */
export type MpEncryptedToken = AesGcmEncrypted;

/**
 * Cifra y descifra los tokens de OAuth de Mercado Pago que se guardan en
 * `mp_accounts`, con la clave `MP_TOKEN_ENCRYPTION_KEY`.
 *
 * El formato y el porqué de cifrar en la app (y no con pgcrypto ni Vault)
 * están en `src/utils/crypto/aes-gcm.ts`, que comparte con ARCA. Acá sólo se
 * elige la clave y se traducen las fallas a los `ErrorCode` de Mercado Pago.
 */
@Injectable()
export class MpCryptoService {
  constructor(private readonly config: MpConfigService) {}

  /**
   * Cifra siempre con la clave ACTIVA y devuelve su versión para persistirla
   * al lado del dato. Sin la versión no hay rotación posible.
   */
  encrypt(plaintext: string): MpEncryptedToken {
    return aesGcmEncrypt(plaintext, this.config.activeEncryptionKey);
  }

  /**
   * Descifra con la clave de la versión indicada, que puede ser anterior a la
   * activa. Si el tag no valida (dato adulterado, clave equivocada, payload
   * truncado) esto FALLA: GCM nunca devuelve plaintext basura.
   */
  decrypt(payload: string, keyVersion: number): string {
    const key = this.config.encryptionKeyFor(keyVersion);
    if (!key) {
      throw new FormattedException(
        'Internal Server Error',
        HttpStatus.INTERNAL_SERVER_ERROR,
        `Unknown Mercado Pago token key version ${keyVersion}. The key was ` +
          'removed from the environment before its rows were re-encrypted.',
        INSTANCE,
        ErrorCodes.MP_TOKEN_KEY_VERSION_UNKNOWN,
      );
    }

    try {
      return aesGcmDecrypt(payload, key);
    } catch (error) {
      if (!(error instanceof AesGcmDecryptError)) throw error;
      throw new FormattedException(
        'Internal Server Error',
        HttpStatus.INTERNAL_SERVER_ERROR,
        `${error.message} (token key version ${keyVersion}).`,
        INSTANCE,
        ErrorCodes.MP_TOKEN_DECRYPT_FAILED,
      );
    }
  }
}
