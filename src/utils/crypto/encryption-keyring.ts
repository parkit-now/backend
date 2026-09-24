import type { ConfigService } from '@nestjs/config';

/** Largo exacto, en bytes, de una clave AES-256 ya decodificada de base64. */
export const AES_256_KEY_BYTES = 32;

/** Versión asumida para la clave activa si no se declara explícitamente. */
const DEFAULT_KEY_VERSION = 1;

/** Las columnas `*_key_version` son `smallint` en la base: ese es el techo real. */
const MAX_KEY_VERSION = 32767;

/** Alfabeto base64 estándar, con padding opcional. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Una clave de cifrado con su número de versión (el que va a la columna). */
export interface EncryptionKey {
  readonly version: number;
  readonly key: Buffer;
}

/** La clave activa (la que cifra) más todas las que pueden descifrar. */
export interface EncryptionKeyring {
  readonly activeKey: EncryptionKey;
  readonly keysByVersion: ReadonlyMap<number, Buffer>;
}

/**
 * Lee y valida un juego de claves AES-256 del entorno con el esquema de
 * rotación que usan las integraciones (Mercado Pago, ARCA):
 *
 * | Variable              | Rol                                                     |
 * | --------------------- | ------------------------------------------------------- |
 * | `<NAME>`              | clave ACTIVA, la que cifra. base64 de 32 bytes           |
 * | `<NAME>_VERSION`      | versión de la activa (entero 1..32767, default 1)        |
 * | `<NAME>_PREVIOUS`     | claves viejas, SOLO para descifrar: `2:<b64>,1:<b64>`    |
 *
 * Los separadores son seguros: el alfabeto base64 estándar no contiene ni `:`
 * ni `,`. Rotar es mover la activa a `_PREVIOUS` con su versión, poner la nueva
 * y subir `_VERSION`; las filas viejas se siguen leyendo con su versión.
 *
 * Tira `Error` con el nombre de la variable en el mensaje: se llama desde un
 * `onModuleInit`, así que un valor roto tumba el arranque a la vista de todos.
 */
export function parseEncryptionKeyring(
  config: Pick<ConfigService, 'get' | 'getOrThrow'>,
  name: string,
): EncryptionKeyring {
  const activeKey: EncryptionKey = {
    version: parseKeyVersion(
      `${name}_VERSION`,
      config.get<string>(`${name}_VERSION`)?.trim() ||
        String(DEFAULT_KEY_VERSION),
    ),
    key: parseKey(name, config.getOrThrow<string>(name)),
  };

  return {
    activeKey,
    keysByVersion: parsePreviousKeys(
      `${name}_PREVIOUS`,
      config.get<string>(`${name}_PREVIOUS`)?.trim(),
      activeKey,
    ),
  };
}

function parseKeyVersion(name: string, value: string): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new Error(
      `${name} debe ser un entero entre 1 y ${MAX_KEY_VERSION} ` +
        `(la columna de versión de clave es smallint). Valor recibido: "${value}".`,
    );
  }
  return version;
}

/** Decodifica una clave base64 y exige que mida exactamente 32 bytes. */
function parseKey(name: string, value: unknown): Buffer {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error(
      `${name} está vacía. Generá una clave con: openssl rand -base64 32`,
    );
  }
  if (!BASE64_PATTERN.test(raw)) {
    throw new Error(
      `${name} no es base64 válido. Generá una clave con: openssl rand -base64 32`,
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `${name} debe decodificar a exactamente ${AES_256_KEY_BYTES} bytes ` +
        `(AES-256) y decodificó a ${key.length}. ` +
        'Generá una clave con: openssl rand -base64 32',
    );
  }
  return key;
}

function parsePreviousKeys(
  name: string,
  raw: string | undefined,
  activeKey: EncryptionKey,
): ReadonlyMap<number, Buffer> {
  const keys = new Map<number, Buffer>([[activeKey.version, activeKey.key]]);
  if (!raw) return keys;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new Error(
        `${name} mal formada. Se espera ` +
          `"<versión>:<clave base64>" separadas por coma; llegó: "${trimmed}".`,
      );
    }

    const version = parseKeyVersion(name, trimmed.slice(0, separator).trim());
    if (keys.has(version)) {
      throw new Error(
        `${name} declara la versión ${version} dos veces (o repite la ` +
          'versión de la clave activa). Cada versión tiene que aparecer una ' +
          'sola vez.',
      );
    }

    keys.set(
      version,
      parseKey(
        `${name} (versión ${version})`,
        trimmed.slice(separator + 1).trim(),
      ),
    );
  }

  return keys;
}
