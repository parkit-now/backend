import { Injectable } from '@nestjs/common';
import {
  AccessTicket,
  Arca,
  ArcaServiceNames,
  AuthRepository,
  type ArcaServiceName,
  type ILoginCredentials,
} from '@arcasdk/core';
import { PrismaService } from '../database/prisma.service';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import {
  type ArcaCredentials,
  type ArcaGateway,
  type ArcaMessage,
  ArcaAlreadyAuthenticatedError,
  ArcaAuthError,
  ArcaRequestError,
  ArcaUnavailableError,
  type ArcaVoucherInfo,
  type ArcaVoucherRequest,
  type ArcaVoucherResult,
} from './arca.gateway';

/** Margen antes del vencimiento del ticket para pedir uno nuevo. */
const TICKET_RENEW_MARGIN_MS = 5 * 60_000;

/**
 * `ArcaGateway` real, sobre `@arcasdk/core` (SOAP directo a ARCA).
 *
 * ## El ticket del WSAA lo maneja Parkit, no el SDK
 *
 * El SDK tiene un `ticketStorage`, pero hace `get` → login → `save` sin lock:
 * dos instancias de Cloud Run sin ticket piden login a la vez y la segunda se
 * come `coe.alreadyAuthenticated`. Por eso el login va acá, dentro de una
 * transacción con `pg_advisory_xact_lock` sobre (certificado, servicio,
 * entorno), y al SDK se le pasa el ticket ya resuelto (`handleTicket` +
 * `credentials`). `pg_try_advisory_lock` no sirve: es de sesión y el pool de
 * Prisma reparte conexiones.
 *
 * ## Timeout propio
 *
 * El SDK no trae timeout. `withTimeout` corta la ESPERA, no el request: si
 * `createVoucher` se corta, el comprobante pudo haber llegado igual, y por eso
 * sale con `outcomeUnknown` y se reconcilia después con `getVoucherInfo`.
 */
@Injectable()
export class ArcaSdkGateway implements ArcaGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ArcaConfigService,
    private readonly crypto: ArcaCryptoService,
  ) {}

  async getServerStatus(creds: ArcaCredentials): Promise<unknown> {
    const arca = await this.client(creds, ArcaServiceNames.WSFE);
    return this.withTimeout(arca.electronicBillingService.getServerStatus());
  }

  async getIvaReceptorTypes(creds: ArcaCredentials): Promise<unknown> {
    const arca = await this.client(creds, ArcaServiceNames.WSFE);
    return this.withTimeout(
      arca.electronicBillingService.getIvaReceptorTypes(),
    );
  }

  async getSalesPoints(creds: ArcaCredentials): Promise<unknown> {
    const arca = await this.client(creds, ArcaServiceNames.WSFE);
    return this.withTimeout(arca.electronicBillingService.getSalesPoints());
  }

  async getTaxpayerDetails(
    creds: ArcaCredentials,
    cuit: string,
  ): Promise<unknown> {
    const arca = await this.client(
      creds,
      ArcaServiceNames.WSSR_INSCRIPTION_PROOF,
    );
    return this.withTimeout(
      arca.registerInscriptionProofService.getTaxpayerDetails(Number(cuit)),
    );
  }

  async getLastVoucher(
    creds: ArcaCredentials,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<number> {
    const arca = await this.client(creds, ArcaServiceNames.WSFE);
    const result = await this.withTimeout(
      arca.electronicBillingService.getLastVoucher(ptoVta, cbteTipo),
    );
    const errors = result.errors?.err ?? [];
    if (errors.length > 0) {
      throw new ArcaRequestError(
        errors.map((e) => `${e.code}: ${e.msg}`).join(' | '),
      );
    }
    return result.cbteNro ?? 0;
  }

  async createVoucher(
    creds: ArcaCredentials,
    voucher: ArcaVoucherRequest,
  ): Promise<ArcaVoucherResult> {
    const arca = await this.client(creds, ArcaServiceNames.WSFE);
    type SdkVoucher = Parameters<
      typeof arca.electronicBillingService.createVoucher
    >[0];
    const request = {
      CantReg: 1,
      ...voucher,
      Iva: voucher.Iva?.map((iva) => ({ ...iva })),
    } as unknown as SdkVoucher;

    let result: Awaited<
      ReturnType<typeof arca.electronicBillingService.createVoucher>
    >;
    try {
      result = await this.withTimeout(
        arca.electronicBillingService.createVoucher(request),
      );
    } catch (error) {
      // El FECAESolicitar pudo haber llegado: no se puede dar por rechazado.
      throw new ArcaUnavailableError(errorMessage(error), true);
    }

    const response = result.response;
    const detail = response?.FeDetResp?.FECAEDetResponse?.[0];
    const messages: ArcaMessage[] = [
      ...(detail?.Observaciones?.Obs ?? []),
      ...(response?.Errors?.Err ?? []),
    ].map((m) => ({ code: m.Code, msg: m.Msg ?? '' }));

    return {
      approved: detail?.Resultado === 'A' && !!result.cae,
      cae: result.cae || undefined,
      caeVto: result.caeFchVto || undefined,
      messages,
      raw: response,
    };
  }

  async getVoucherInfo(
    creds: ArcaCredentials,
    cbteNro: number,
    ptoVta: number,
    cbteTipo: number,
  ): Promise<ArcaVoucherInfo | null> {
    const arca = await this.client(creds, ArcaServiceNames.WSFE);
    const info = await this.withTimeout(
      arca.electronicBillingService.getVoucherInfo(cbteNro, ptoVta, cbteTipo),
    );
    if (!info?.codAutorizacion) return null;
    return {
      cae: info.codAutorizacion,
      caeVto: info.fchVto,
      impTotal: info.impTotal,
    };
  }

  /** Una instancia del SDK por servicio: cada servicio tiene su ticket. */
  private async client(
    creds: ArcaCredentials,
    service: ArcaServiceName,
  ): Promise<Arca> {
    const credentials = await this.ticketFor(creds, service);
    return new Arca({
      cuit: Number(creds.cuit),
      cert: creds.certPem,
      key: creds.keyPem,
      production: creds.environment === 'produccion',
      handleTicket: true,
      credentials,
    });
  }

  private async ticketFor(
    creds: ArcaCredentials,
    service: ArcaServiceName,
  ): Promise<ILoginCredentials> {
    const where = {
      certFingerprint_service_environment: {
        certFingerprint: creds.certFingerprint,
        service,
        environment: creds.environment,
      },
    };

    const cached = await this.prisma.arcaAccessTicket.findUnique({ where });
    if (cached && this.isUsable(cached.expiresAt)) {
      return this.decryptTicket(cached);
    }

    const lockKey = `arca-ta:${creds.environment}:${creds.certFingerprint}:${service}`;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        // Otra instancia pudo haberlo renovado mientras esperábamos el lock.
        const again = await tx.arcaAccessTicket.findUnique({ where });
        if (again && this.isUsable(again.expiresAt)) {
          return this.decryptTicket(again);
        }

        const ticket = await this.login(creds, service);
        const encrypted = this.crypto.encrypt(
          JSON.stringify(ticket.toLoginCredentials()),
        );
        const data = {
          credentialsEncrypted: encrypted.ciphertext,
          keyVersion: encrypted.keyVersion,
          expiresAt: ticket.getExpiration(),
        };
        await tx.arcaAccessTicket.upsert({
          where,
          create: {
            certFingerprint: creds.certFingerprint,
            service,
            environment: creds.environment,
            ...data,
          },
          update: data,
        });
        return ticket.toLoginCredentials();
      },
      { timeout: this.config.timeoutMs + 5_000 },
    );
  }

  private async login(
    creds: ArcaCredentials,
    service: ArcaServiceName,
  ): Promise<AccessTicket> {
    const auth = new AuthRepository({
      cuit: Number(creds.cuit),
      cert: creds.certPem,
      key: creds.keyPem,
      production: creds.environment === 'produccion',
      handleTicket: true,
    });
    try {
      return await this.withTimeout(auth.requestLogin(service));
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('alreadyAuthenticated')) {
        throw new ArcaAlreadyAuthenticatedError(
          'ARCA ya entregó un ticket vigente para este certificado que Parkit ' +
            'no tiene guardado. Se libera solo cuando vence (hasta 12 h).',
        );
      }
      const authError = classifyWsaaError(message);
      if (authError) throw authError;
      throw new ArcaUnavailableError(message);
    }
  }

  private isUsable(expiresAt: Date): boolean {
    return expiresAt.getTime() - Date.now() > TICKET_RENEW_MARGIN_MS;
  }

  private decryptTicket(row: {
    credentialsEncrypted: string;
    keyVersion: number;
  }): ILoginCredentials {
    return JSON.parse(
      this.crypto.decrypt(row.credentialsEncrypted, row.keyVersion),
    ) as ILoginCredentials;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const ms = this.config.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new ArcaUnavailableError(`ARCA no respondió en ${ms} ms.`)),
        ms,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Los rechazos del WSAA que no son "ARCA está caído": vienen como SOAP fault
 * con un código `coe.*` / `cms.*` en el mensaje (p. ej. `coe.notAuthorized:
 * Computador no autorizado a acceder al servicio`).
 */
export function classifyWsaaError(message: string): ArcaAuthError | null {
  if (/notAuthorized|no autorizado/i.test(message)) {
    return new ArcaAuthError('not_authorized', message);
  }
  if (/cms\.|cert\.(untrusted|expired|revoked)|certificado/i.test(message)) {
    return new ArcaAuthError('cert_rejected', message);
  }
  return null;
}
