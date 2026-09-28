import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ArcaEnvironment } from '@prisma/client';
import {
  type EncryptionKey,
  parseEncryptionKeyring,
} from '../utils/crypto/encryption-keyring';

const DEFAULT_TIMEOUT_MS = 15_000;
const ENVIRONMENTS: readonly ArcaEnvironment[] = ['homologacion', 'produccion'];

interface ArcaSettings {
  readonly environment: ArcaEnvironment;
  readonly timeoutMs: number;
  readonly activeKey: EncryptionKey;
  readonly keysByVersion: ReadonlyMap<number, Buffer>;
}

/**
 * Configuración de la integración con ARCA, validada AL BOOT.
 *
 * | Variable                             | Rol                                                   |
 * | ------------------------------------ | ----------------------------------------------------- |
 * | `ARCA_ENV`                           | `homologacion` \| `produccion`. Uno por deploy          |
 * | `ARCA_KEY_ENCRYPTION_KEY`            | cifra las claves privadas. `openssl rand -base64 32`   |
 * | `ARCA_KEY_ENCRYPTION_KEY_VERSION`    | versión de la activa (default 1)                        |
 * | `ARCA_KEY_ENCRYPTION_KEY_PREVIOUS`   | claves viejas para descifrar: `1:<b64>,...`             |
 * | `ARCA_TIMEOUT_MS`                    | corte de cada llamada a ARCA (default 15000)            |
 *
 * ## Por qué, a diferencia de Mercado Pago, sin `ARCA_ENV` NO se cae el boot
 *
 * Sin `ARCA_ENV` la integración queda APAGADA: ninguna estadía crea factura y
 * los endpoints responden `ARCA_NOT_LINKED`. Así un entorno que todavía no la
 * configuró (el de otro dev, un preview) sigue levantando. Pero si `ARCA_ENV`
 * está, TODO lo demás se valida acá y un valor roto sí tumba el arranque: la
 * alternativa es enterarse en el primer cobro.
 *
 * Es otra clave que la de Mercado Pago a propósito: comprometer una no expone
 * los secretos de la otra integración.
 */
@Injectable()
export class ArcaConfigService implements OnModuleInit {
  private readonly logger = new Logger(ArcaConfigService.name);

  private settings?: ArcaSettings | null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.settings = this.loadSettings();
    if (!this.settings) {
      this.logger.warn(
        'ARCA_ENV no está configurada: la facturación electrónica queda apagada.',
      );
      return;
    }
    this.logger.log(
      `Facturación ARCA en ${this.settings.environment} ` +
        `(timeout ${this.settings.timeoutMs} ms, clave v${this.settings.activeKey.version}).`,
    );
  }

  get enabled(): boolean {
    return this.requireLoaded() !== null;
  }

  get environment(): ArcaEnvironment {
    return this.requireSettings().environment;
  }

  get production(): boolean {
    return this.environment === 'produccion';
  }

  get timeoutMs(): number {
    return this.requireSettings().timeoutMs;
  }

  get activeEncryptionKey(): EncryptionKey {
    return this.requireSettings().activeKey;
  }

  encryptionKeyFor(version: number): Buffer | undefined {
    return this.requireSettings().keysByVersion.get(version);
  }

  private requireLoaded(): ArcaSettings | null {
    if (this.settings === undefined) {
      throw new Error(
        'ArcaConfigService se usó antes de inicializarse. Tiene que estar ' +
          'provisto por ArcaModule para que Nest corra su onModuleInit.',
      );
    }
    return this.settings;
  }

  private requireSettings(): ArcaSettings {
    const settings = this.requireLoaded();
    if (!settings) {
      throw new Error('La facturación ARCA está apagada (falta ARCA_ENV).');
    }
    return settings;
  }

  private loadSettings(): ArcaSettings | null {
    const rawEnv = this.config.get<string>('ARCA_ENV')?.trim();
    if (!rawEnv) return null;

    if (!ENVIRONMENTS.includes(rawEnv as ArcaEnvironment)) {
      throw new Error(
        `ARCA_ENV debe ser "homologacion" o "produccion" (valor: "${rawEnv}").`,
      );
    }

    const rawTimeout = this.config.get<string>('ARCA_TIMEOUT_MS')?.trim();
    const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(
        `ARCA_TIMEOUT_MS debe ser un entero positivo en milisegundos (valor: "${rawTimeout}").`,
      );
    }

    const { activeKey, keysByVersion } = parseEncryptionKeyring(
      this.config,
      'ARCA_KEY_ENCRYPTION_KEY',
    );

    return {
      environment: rawEnv as ArcaEnvironment,
      timeoutMs,
      activeKey,
      keysByVersion,
    };
  }
}
