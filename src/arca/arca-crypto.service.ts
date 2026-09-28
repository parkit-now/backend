import { Injectable } from '@nestjs/common';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type AesGcmEncrypted,
} from '../utils/crypto/aes-gcm';
import { ArcaConfigService } from './arca-config.service';

/**
 * Cifra las claves privadas de los certificados y los tickets del WSAA con
 * `ARCA_KEY_ENCRYPTION_KEY`. Formato y motivos en `src/utils/crypto/aes-gcm.ts`.
 *
 * Una falla de descifrado es un 500 sin vuelta: la clave del entorno no es la
 * que cifró la fila. No hay nada que el usuario pueda corregir desde la UI.
 */
@Injectable()
export class ArcaCryptoService {
  constructor(private readonly config: ArcaConfigService) {}

  encrypt(plaintext: string): AesGcmEncrypted {
    return aesGcmEncrypt(plaintext, this.config.activeEncryptionKey);
  }

  decrypt(payload: string, keyVersion: number): string {
    const key = this.config.encryptionKeyFor(keyVersion);
    if (!key) {
      throw new Error(
        `ARCA_KEY_ENCRYPTION_KEY versión ${keyVersion} no está en el entorno: ` +
          'se sacó antes de re-cifrar sus filas.',
      );
    }
    return aesGcmDecrypt(payload, key);
  }
}
