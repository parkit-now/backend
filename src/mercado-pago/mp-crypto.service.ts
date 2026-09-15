import { HttpStatus, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpConfigService } from './mp-config.service';

/** AES-GCM recomienda 12 bytes de IV: es el largo nativo del modo. */
const IV_BYTES = 12;

/** El tag de autenticación de GCM que produce Node mide 16 bytes. */
const TAG_BYTES = 16;

const ALGORITHM = 'aes-256-gcm';

/** Ruta lógica para el campo `instance` de los ProblemDetails. */
const INSTANCE = '/mercado-pago/tokens';

/** Resultado de cifrar: lo que va a las dos columnas de `mp_accounts`. */
export interface MpEncryptedToken {
  /** `base64(iv[12] || tag[16] || ciphertext)` — columna `text`. */
  readonly ciphertext: string;
  /** Versión de la clave usada — columna `token_key_version smallint`. */
  readonly keyVersion: number;
}

/**
 * Cifra y descifra los tokens de OAuth de Mercado Pago que se guardan en
 * `mp_accounts`.
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
 * Tentador, porque cifrar en la base se escribe en una línea. El problema es
 * el dominio de confianza: nuestra base es Supabase **gestionada**. Si la
 * clave vive en la base (pgcrypto con la clave en la query, o Vault, que
 * guarda las claves en el mismo proyecto), entonces quien obtiene acceso a la
 * base obtiene también con qué descifrar. El cifrado deja de proteger contra
 * el escenario que justamente queremos cubrir: un dump.
 *
 * Con la clave en variables de entorno de Cloud Run, un dump de la base es
 * inútil por sí solo: hace falta comprometer TAMBIÉN el runtime. Son dos
 * sistemas distintos, con dos superficies de ataque distintas.
 *
 * Costo adicional que aceptamos a cambio: no se puede descifrar desde SQL
 * (ni desde el editor de Supabase), y hay que rotar claves a mano
 * (ver `MpConfigService`). Vale la pena. **No "optimizar" esto moviendo el
 * cifrado a la base.**
 */
@Injectable()
export class MpCryptoService {
  constructor(private readonly config: MpConfigService) {}

  /**
   * Cifra siempre con la clave ACTIVA y devuelve su versión para persistirla
   * al lado del dato. Sin la versión no hay rotación posible.
   */
  encrypt(plaintext: string): MpEncryptedToken {
    const { key, version } = this.config.activeEncryptionKey;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: Buffer.concat([iv, tag, ciphertext]).toString('base64'),
      keyVersion: version,
    };
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

    const raw = Buffer.from(payload, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) {
      throw this.decryptFailed(
        `Encrypted token is too short (${raw.length} bytes).`,
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
      throw this.decryptFailed(
        `Authentication tag check failed for token key version ${keyVersion}.`,
      );
    }
  }

  private decryptFailed(detail: string): FormattedException {
    return new FormattedException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
      detail,
      INSTANCE,
      ErrorCodes.MP_TOKEN_DECRYPT_FAILED,
    );
  }
}
