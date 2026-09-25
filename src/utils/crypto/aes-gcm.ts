import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptionKey } from './encryption-keyring';

/** AES-GCM recomienda 12 bytes de IV: es el largo nativo del modo. */
const IV_BYTES = 12;

/** El tag de autenticación de GCM que produce Node mide 16 bytes. */
const TAG_BYTES = 16;

const ALGORITHM = 'aes-256-gcm';

/** Resultado de cifrar: el payload y la versión de la clave que lo cifró. */
export interface AesGcmEncrypted {
  /** `base64(iv[12] || tag[16] || ciphertext)` — columna `text`. */
  readonly ciphertext: string;
  /** Versión de la clave usada — columna `*_key_version smallint`. */
  readonly keyVersion: number;
}

/**
 * Falla de descifrado. Cada integración la traduce a su propio `ErrorCode`
 * (`MP_TOKEN_DECRYPT_FAILED`, etc.): este módulo no sabe de HTTP.
 */
export class AesGcmDecryptError extends Error {}

/**
 * Cifra con AES-256-GCM y un IV aleatorio por operación.
 *
 * ## Formato
 *
 * `base64(iv[12] || tag[16] || ciphertext)`, una sola columna `text`. IV
 * aleatorio por operación: reutilizar un IV con la misma clave en GCM no es
 * "un poco peor", es catastrófico (se filtra el XOR de los plaintexts y se
 * puede forjar el tag). Por eso el IV nunca se deriva ni se cachea.
 *
 * El tag va adelante, junto al IV, para que el header tenga largo fijo (28
 * bytes) y el resto sea ciphertext: parsear es aritmética de offsets, sin
 * separadores ni JSON.
 *
 * ## Por qué NO usamos pgcrypto ni Supabase Vault
 *
 * Nuestra base es Supabase **gestionada**. Si la clave vive en la base,
 * quien obtiene acceso a la base obtiene también con qué descifrar. Con la
 * clave en el entorno de Cloud Run, un dump de la base es inútil por sí solo:
 * hace falta comprometer TAMBIÉN el runtime. **No "optimizar" esto moviendo
 * el cifrado a la base.**
 */
export function aesGcmEncrypt(
  plaintext: string,
  activeKey: EncryptionKey,
): AesGcmEncrypted {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, activeKey.key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([iv, tag, ciphertext]).toString('base64'),
    keyVersion: activeKey.version,
  };
}

/**
 * Descifra un payload de `aesGcmEncrypt`. Si el tag no valida (dato
 * adulterado, clave equivocada, payload truncado) tira `AesGcmDecryptError`:
 * GCM nunca devuelve plaintext basura.
 */
export function aesGcmDecrypt(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new AesGcmDecryptError(
      `Encrypted payload is too short (${raw.length} bytes).`,
    );
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // El motivo real (tag inválido vs. clave equivocada) no se expone: es
    // información gratis para quien esté probando payloads.
    throw new AesGcmDecryptError('Authentication tag check failed.');
  }
}
