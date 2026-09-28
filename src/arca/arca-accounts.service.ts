import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ArcaAccount, User } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  normalizeCertificatePem,
  parseArcaCertificate,
} from './arca-cert.util';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import {
  aliasFromPem,
  arcaCertAlias,
  certMatchesKey,
  generateArcaCsr,
} from './arca-csr';
import { isValidCuit, normalizeCuit } from './arca-cuit';
import { fromArcaDate } from './arca-dates';
import { parseTaxpayer } from './arca-padron';
import { checkSalesPoint } from './arca-sales-points';
import {
  ARCA_GATEWAY,
  ArcaAlreadyAuthenticatedError,
  ArcaAuthError,
  type ArcaCredentials,
  type ArcaGateway,
  ArcaRequestError,
  ArcaUnavailableError,
} from './arca.gateway';
import {
  ArcaAccountDto,
  ArcaCertificateResultDto,
  ArcaCsrDto,
  ArcaReusableCertificateDto,
  CreateArcaAccountDto,
  ReuseArcaCertificateDto,
  SetArcaSalesPointDto,
  UpdateArcaAccountDto,
  UploadArcaCertificateDto,
} from './dto/arca-account.dto';
import { CbteTipos } from './resolve-voucher';

const INSTANCE = '/tenants/:tenantId/arca/account';

/** Las cuentas que emiten (o emitían hasta que venció el certificado). */
const ACTIVE_STATUSES: ReadonlyArray<ArcaAccount['status']> = [
  'linked',
  'cert_expired',
];

/** Los pasos del wizard: la vinculación empezó pero no terminó. */
const PENDING_STATUSES: ReadonlyArray<ArcaAccount['status']> = [
  'pending_certificate',
  'pending_sales_point',
];

/** La cuenta con el certificado ya verificado: se puede hablar con ARCA. */
export type CertifiedAccount = ArcaAccount & {
  certPem: string;
  keyEncrypted: string;
  keyVersion: number;
  certFingerprint: string;
};

/**
 * Vinculación de ARCA desde el panel: el wizard de tres pasos (CUIT →
 * certificado → punto de venta), la configuración y el desvincular.
 *
 * Sigue el modelo de la Etapa 0 sin OpenSSL: Parkit genera la clave y el CSR,
 * el dueño lo sube a ARCA y trae de vuelta el `.crt`. La clave nunca sale de
 * acá y se guarda cifrada (`ArcaCryptoService`).
 *
 * `arca_accounts` es global (el aislamiento es explícito por `tenantId`, como
 * `mp_accounts`): el `TenantMembershipGuard` del controller ya validó que
 * quien llama es miembro de ESA playa.
 */
@Injectable()
export class ArcaAccountsService {
  private readonly logger = new Logger(ArcaAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ArcaConfigService,
    private readonly crypto: ArcaCryptoService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    @Inject(ARCA_GATEWAY) private readonly gateway: ArcaGateway,
  ) {}

  async getAccount(tenantId: string): Promise<ArcaAccountDto> {
    return this.toDto(await this.requireAccount(tenantId));
  }

  /** Paso 1: CUIT e Ingresos Brutos. Genera la clave y la solicitud (CSR). */
  async create(
    tenantId: string,
    dto: CreateArcaAccountDto,
  ): Promise<ArcaAccountDto> {
    this.assertEnabled();

    const cuit = normalizeCuit(dto.cuit);
    if (!isValidCuit(cuit)) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `"${dto.cuit}" is not a valid CUIT.`,
        ErrorCodes.ARCA_CUIT_INVALID,
      );
    }

    const existing = await this.prisma.arcaAccount.findUnique({
      where: { tenantId },
    });
    if (existing && ACTIVE_STATUSES.includes(existing.status)) {
      throw this.error(
        HttpStatus.CONFLICT,
        'The entity already has an ARCA account linked. Unlink it first.',
        ErrorCodes.ARCA_ALREADY_LINKED,
      );
    }

    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const { keyPem, csrPem } = generateArcaCsr({
      cuit,
      alias: arcaCertAlias(tenant.name, tenantId),
    });
    const key = this.crypto.encrypt(keyPem);

    // Empezar de nuevo pisa TODO lo del intento anterior: otro CUIT no puede
    // heredar ni el certificado ni los datos fiscales del que había.
    const data = {
      environment: this.config.environment,
      status: 'pending_certificate' as const,
      cuit,
      iibb: dto.iibb.trim(),
      csrPem,
      keyEncrypted: key.ciphertext,
      keyVersion: key.keyVersion,
      ...CLEARED_CERTIFICATE,
      ...CLEARED_FISCAL_DATA,
      ptoVta: null,
      linkedAt: null,
    };
    const account = await this.prisma.arcaAccount.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    return this.toDto(account);
  }

  async getCsr(tenantId: string): Promise<ArcaCsrDto> {
    const account = await this.requireAccount(tenantId);
    if (!PENDING_STATUSES.includes(account.status) || !account.csrPem) {
      throw this.stepInvalid('There is no pending certificate request.');
    }
    const alias = aliasFromPem(account.csrPem) ?? 'parkit';
    return { fileName: `${alias}.csr`, alias, csrPem: account.csrPem };
  }

  /**
   * Paso 2: el `.crt` que devolvió ARCA. Se valida en este orden, del error
   * más barato al más caro: que sea un certificado, que sea de este CUIT, que
   * no esté vencido, que sea de NUESTRA clave, y recién ahí se le pregunta a
   * ARCA (login a los dos servicios + padrón).
   */
  async uploadCertificate(
    tenantId: string,
    dto: UploadArcaCertificateDto,
  ): Promise<ArcaCertificateResultDto> {
    this.assertEnabled();
    const account = await this.requireAccount(tenantId);
    if (
      !PENDING_STATUSES.includes(account.status) ||
      !account.keyEncrypted ||
      account.keyVersion === null
    ) {
      throw this.stepInvalid('Generate the certificate request first.');
    }

    const certPem = normalizeCertificatePem(dto.certificate);
    let cert: ReturnType<typeof parseArcaCertificate>;
    try {
      cert = parseArcaCertificate(certPem);
    } catch (error) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Not an ARCA certificate: ${errorMessage(error)}`,
        ErrorCodes.ARCA_CERT_INVALID,
      );
    }
    if (cert.cuit !== account.cuit) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `The certificate belongs to CUIT ${cert.cuit}, not ${account.cuit}.`,
        ErrorCodes.ARCA_CERT_CUIT_MISMATCH,
      );
    }
    if (cert.notAfter.getTime() <= Date.now()) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `The certificate expired on ${cert.notAfter.toISOString()}.`,
        ErrorCodes.ARCA_CERT_EXPIRED,
      );
    }

    const keyPem = this.crypto.decrypt(
      account.keyEncrypted,
      account.keyVersion,
    );
    if (!certMatchesKey(certPem, keyPem)) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The certificate was not issued for the certificate request generated by Parkit.',
        ErrorCodes.ARCA_CERT_KEY_MISMATCH,
      );
    }

    const creds: ArcaCredentials = {
      cuit: account.cuit,
      certPem,
      keyPem,
      certFingerprint: cert.fingerprint,
      environment: account.environment,
    };

    // Login a Facturación Electrónica: si el servicio no está asociado, acá
    // salta. `getServerStatus` es la llamada más liviana que pasa por el WSAA.
    await this.callArca('wsfe', () => this.gateway.getServerStatus(creds));
    // Y a la constancia de inscripción, que además trae los datos fiscales.
    const fiscal = parseTaxpayer(
      await this.callArca('ws_sr_constancia_inscripcion', () =>
        this.gateway.getTaxpayerDetails(creds, account.cuit),
      ),
    );
    const padronFound = !!fiscal?.condicionIva;

    // En producción la letra de la factura sale del padrón y de ningún otro
    // lado: cargarla a mano es poder emitir C siendo responsable inscripto.
    if (!padronFound && this.config.production) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `ARCA's registry has no IVA condition for CUIT ${account.cuit}.`,
        ErrorCodes.ARCA_PADRON_NOT_FOUND,
      );
    }

    const updated = await this.prisma.arcaAccount.update({
      where: { id: account.id },
      data: {
        status: 'pending_sales_point',
        certPem,
        certFingerprint: cert.fingerprint,
        certExpiresAt: cert.notAfter,
        razonSocial: fiscal?.razonSocial ?? account.razonSocial,
        condicionIva: fiscal?.condicionIva ?? account.condicionIva,
        domicilioFiscal: fiscal?.domicilioFiscal ?? account.domicilioFiscal,
      },
    });
    return { account: this.toDto(updated), padronFound };
  }

  /** IVA (%) y, sólo en homologación, los datos fiscales cargados a mano. */
  async update(
    tenantId: string,
    dto: UpdateArcaAccountDto,
  ): Promise<ArcaAccountDto> {
    const account = await this.requireAccount(tenantId);

    const fiscal = {
      razonSocial: dto.razonSocial?.trim(),
      condicionIva: dto.condicionIva,
      domicilioFiscal: dto.domicilioFiscal?.trim(),
    };
    const touchesFiscal = Object.values(fiscal).some((v) => v !== undefined);
    if (touchesFiscal && account.environment !== 'homologacion') {
      throw this.stepInvalid(
        'Fiscal data comes from ARCA’s registry and cannot be edited in production.',
      );
    }
    if (touchesFiscal && account.status === 'pending_certificate') {
      throw this.stepInvalid('Upload the certificate first.');
    }

    const updated = await this.prisma.arcaAccount.update({
      where: { id: account.id },
      data: {
        ...fiscal,
        ivaRate: dto.ivaRate,
        iibb: dto.iibb?.trim(),
        inicioActividad:
          dto.inicioActividad !== undefined
            ? fromArcaDate(dto.inicioActividad.replace(/-/g, ''))
            : undefined,
      },
    });
    return this.toDto(updated);
  }

  /**
   * Paso 3: el punto de venta. Tiene que figurar en `FEParamGetPtosVenta` (que
   * sólo lista los de web services) y `getLastVoucher` tiene que responder
   * para la letra de esta playa. Si todo da, queda `linked`.
   */
  async setSalesPoint(
    tenantId: string,
    user: User,
    dto: SetArcaSalesPointDto,
  ): Promise<ArcaAccountDto> {
    this.assertEnabled();
    const account = await this.requireAccount(tenantId);
    if (account.status !== 'pending_sales_point' || !isCertified(account)) {
      throw this.stepInvalid('Upload a valid certificate first.');
    }
    if (!account.condicionIva) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The IVA condition is still missing: load the fiscal data first.',
        ErrorCodes.ARCA_PADRON_NOT_FOUND,
      );
    }
    // IIBB e inicio de actividades van impresos en la factura (RG 1415): sin
    // ellos no se vincula. Se chequea antes de hablar con ARCA.
    const inicioActividad = dto.inicioActividad
      ? fromArcaDate(dto.inicioActividad.replace(/-/g, ''))
      : account.inicioActividad;
    if (!account.iibb?.trim() || !inicioActividad) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Gross income registration and start-of-activity date are required.',
        ErrorCodes.ARCA_FISCAL_DATA_INCOMPLETE,
      );
    }

    const creds = this.credentials(account);
    const check = checkSalesPoint(
      await this.callArca('wsfe', () => this.gateway.getSalesPoints(creds)),
      dto.ptoVta,
    );
    // Homologación no tiene puntos de venta dados de alta: la lista viene
    // vacía y alcanza con que `getLastVoucher` responda.
    if (
      check === 'not_found' ||
      (check === 'empty' && this.config.production)
    ) {
      throw this.posNotFound(dto.ptoVta);
    }
    if (check === 'disabled') {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Sales point ${dto.ptoVta} is blocked or was deregistered in ARCA.`,
        ErrorCodes.ARCA_POS_DISABLED,
      );
    }

    const cbteTipo =
      account.condicionIva === 'responsable_inscripto'
        ? CbteTipos.B
        : CbteTipos.C;
    try {
      await this.gateway.getLastVoucher(creds, dto.ptoVta, cbteTipo);
    } catch (error) {
      if (error instanceof ArcaRequestError) {
        throw this.posNotFound(dto.ptoVta, error.message);
      }
      throw this.mapArcaError(error, 'wsfe');
    }

    const updated = await this.prisma.arcaAccount.update({
      where: { id: account.id },
      data: {
        status: 'linked',
        ptoVta: dto.ptoVta,
        inicioActividad,
        linkedAt: new Date(),
      },
    });

    await this.audit.record({
      action: AuditActions.ARCA_ACCOUNT_LINKED,
      entityType: 'arca_account',
      entityId: account.id,
      actorUserId: user.id,
      tenantId,
      metadata: {
        cuit: account.cuit,
        ptoVta: dto.ptoVta,
        environment: account.environment,
        condicionIva: account.condicionIva,
      },
    });
    return this.toDto(updated);
  }

  /**
   * Las otras playas de las que quien llama es dueño, vinculadas con el mismo
   * CUIT: su certificado sirve tal cual (el ticket del WSAA va por
   * certificado, así que además lo comparten).
   */
  async listReusableCertificates(
    tenantId: string,
    user: User,
  ): Promise<ArcaReusableCertificateDto[]> {
    const account = await this.requireAccount(tenantId);
    const candidates = await this.prisma.arcaAccount.findMany({
      where: {
        cuit: account.cuit,
        environment: account.environment,
        status: 'linked',
        tenantId: { not: tenantId },
        certPem: { not: null },
        keyEncrypted: { not: null },
        certExpiresAt: { gt: new Date() },
      },
      include: { tenant: { select: { name: true } } },
      orderBy: { linkedAt: 'asc' },
    });

    const owned = await this.ownedTenantIds(
      user,
      candidates.map((c) => c.tenantId),
    );
    return candidates
      .filter((c) => owned.has(c.tenantId))
      .map((c) => ({
        tenantId: c.tenantId,
        tenantName: c.tenant.name,
        cuit: c.cuit,
        razonSocial: c.razonSocial,
        certExpiresAt: c.certExpiresAt?.toISOString() ?? null,
      }));
  }

  /**
   * Atajo del paso 2: copia el certificado (y los datos fiscales) de otra
   * sede. El punto de venta NO se copia: cada sede tiene el suyo.
   */
  async reuseCertificate(
    tenantId: string,
    user: User,
    dto: ReuseArcaCertificateDto,
  ): Promise<ArcaAccountDto> {
    this.assertEnabled();
    const account = await this.requireAccount(tenantId);
    if (!PENDING_STATUSES.includes(account.status)) {
      throw this.stepInvalid('The linking is not in progress.');
    }

    const reusable = await this.listReusableCertificates(tenantId, user);
    if (!reusable.some((r) => r.tenantId === dto.fromTenantId)) {
      throw this.stepInvalid(
        'That entity has no reusable ARCA certificate for this CUIT.',
      );
    }
    const source = await this.prisma.arcaAccount.findUniqueOrThrow({
      where: { tenantId: dto.fromTenantId },
    });

    const updated = await this.prisma.arcaAccount.update({
      where: { id: account.id },
      data: {
        status: 'pending_sales_point',
        csrPem: null,
        certPem: source.certPem,
        keyEncrypted: source.keyEncrypted,
        keyVersion: source.keyVersion,
        certFingerprint: source.certFingerprint,
        certExpiresAt: source.certExpiresAt,
        iibb: account.iibb ?? source.iibb,
        razonSocial: source.razonSocial,
        condicionIva: source.condicionIva,
        domicilioFiscal: source.domicilioFiscal,
        inicioActividad: source.inicioActividad,
        ivaRate: source.ivaRate,
        // Si el certificado ya tiene la renovación en marcha, se comparte:
        // las sedes con el mismo certificado renuevan juntas.
        renewalCsrPem: source.renewalCsrPem,
        renewalKeyEncrypted: source.renewalKeyEncrypted,
        renewalKeyVersion: source.renewalKeyVersion,
        renewalPreparedAt: source.renewalPreparedAt,
      },
    });
    return this.toDto(updated);
  }

  /**
   * La solicitud (CSR) para renovar el certificado. Si el job todavía no la
   * preparó, se genera en el momento. Se puede pedir en cualquier momento, no
   * sólo cerca del vencimiento: renovar antes no rompe nada.
   */
  async getRenewalCsr(tenantId: string): Promise<ArcaCsrDto> {
    this.assertEnabled();
    const account = await this.requireRenewable(tenantId);
    const renewal = await this.prepareRenewal(account);
    const alias = aliasFromPem(renewal.csrPem) ?? 'parkit';
    return {
      fileName: `${alias}-renovacion.csr`,
      alias,
      csrPem: renewal.csrPem,
    };
  }

  /**
   * Deja la clave y el CSR de renovación de un certificado, sin tocar el
   * vigente, en TODAS las sedes que lo comparten: el certificado es uno solo.
   * El CSR lleva el alias del certificado actual, que es lo que ARCA pide
   * para «Agregar certificado» y conservar los servicios asociados.
   *
   * Idempotente y a prueba de carreras (el job y el panel a la vez): se
   * escribe sólo donde todavía no hay renovación, y se devuelve lo que quedó
   * guardado, que puede ser lo de la otra corrida.
   */
  async prepareRenewal(account: CertifiedAccount): Promise<{ csrPem: string }> {
    const siblings = {
      certFingerprint: account.certFingerprint,
      environment: account.environment,
    };
    const existing = await this.prisma.arcaAccount.findFirst({
      where: { ...siblings, renewalCsrPem: { not: null } },
    });

    let renewal = existing?.renewalCsrPem
      ? {
          renewalCsrPem: existing.renewalCsrPem,
          renewalKeyEncrypted: existing.renewalKeyEncrypted,
          renewalKeyVersion: existing.renewalKeyVersion,
          renewalPreparedAt: existing.renewalPreparedAt,
        }
      : null;
    if (!renewal) {
      const alias =
        aliasFromPem(account.certPem) ??
        arcaCertAlias(
          (
            await this.prisma.tenant.findUniqueOrThrow({
              where: { id: account.tenantId },
              select: { name: true },
            })
          ).name,
          account.tenantId,
        );
      const { keyPem, csrPem } = generateArcaCsr({ cuit: account.cuit, alias });
      const key = this.crypto.encrypt(keyPem);
      renewal = {
        renewalCsrPem: csrPem,
        renewalKeyEncrypted: key.ciphertext,
        renewalKeyVersion: key.keyVersion,
        renewalPreparedAt: new Date(),
      };
    }

    await this.prisma.arcaAccount.updateMany({
      where: { ...siblings, renewalCsrPem: null },
      data: renewal,
    });
    const stored = await this.prisma.arcaAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    return { csrPem: stored.renewalCsrPem! };
  }

  /**
   * El certificado renovado. Mismas validaciones que el paso 2 del wizard,
   * pero contra la clave de RENOVACIÓN. Si todo da, cambia el certificado en
   * todas las sedes que lo comparten y la playa vuelve a `linked` aunque el
   * viejo ya hubiera vencido.
   */
  async uploadRenewalCertificate(
    tenantId: string,
    user: User,
    dto: UploadArcaCertificateDto,
  ): Promise<ArcaAccountDto> {
    this.assertEnabled();
    const account = await this.requireRenewable(tenantId);
    if (
      !account.renewalCsrPem ||
      !account.renewalKeyEncrypted ||
      account.renewalKeyVersion === null
    ) {
      throw this.stepInvalid('Download the renewal request first.');
    }

    const certPem = normalizeCertificatePem(dto.certificate);
    let cert: ReturnType<typeof parseArcaCertificate>;
    try {
      cert = parseArcaCertificate(certPem);
    } catch (error) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `Not an ARCA certificate: ${errorMessage(error)}`,
        ErrorCodes.ARCA_CERT_INVALID,
      );
    }
    if (cert.cuit !== account.cuit) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `The certificate belongs to CUIT ${cert.cuit}, not ${account.cuit}.`,
        ErrorCodes.ARCA_CERT_CUIT_MISMATCH,
      );
    }
    if (cert.notAfter.getTime() <= Date.now()) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        `The certificate expired on ${cert.notAfter.toISOString()}.`,
        ErrorCodes.ARCA_CERT_EXPIRED,
      );
    }
    const keyPem = this.crypto.decrypt(
      account.renewalKeyEncrypted,
      account.renewalKeyVersion,
    );
    if (!certMatchesKey(certPem, keyPem)) {
      throw this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The certificate was not issued for the renewal request generated by Parkit.',
        ErrorCodes.ARCA_CERT_KEY_MISMATCH,
      );
    }

    const creds: ArcaCredentials = {
      cuit: account.cuit,
      certPem,
      keyPem,
      certFingerprint: cert.fingerprint,
      environment: account.environment,
    };
    await this.verifyRenewalLogin('wsfe', () =>
      this.gateway.getServerStatus(creds),
    );
    await this.verifyRenewalLogin('ws_sr_constancia_inscripcion', () =>
      this.gateway.getTaxpayerDetails(creds, account.cuit),
    );

    const oldFingerprint = account.certFingerprint;
    await this.prisma.$transaction(async (tx) => {
      const siblings = {
        certFingerprint: oldFingerprint,
        environment: account.environment,
      };
      // Vuelven a `linked` las que ya emitían; una sede con el wizard a medias
      // (reusó el certificado) cambia de certificado pero sigue en su paso.
      await tx.arcaAccount.updateMany({
        where: { ...siblings, status: 'cert_expired' },
        data: { status: 'linked' },
      });
      await tx.arcaAccount.updateMany({
        where: siblings,
        data: {
          certPem,
          certFingerprint: cert.fingerprint,
          certExpiresAt: cert.notAfter,
          keyEncrypted: account.renewalKeyEncrypted,
          keyVersion: account.renewalKeyVersion,
          renewalCsrPem: null,
          renewalKeyEncrypted: null,
          renewalKeyVersion: null,
          renewalPreparedAt: null,
        },
      });

      // Los tickets del certificado viejo: si el login con el nuevo ya dejó
      // el suyo, sobran; si no (ARCA contestó `alreadyAuthenticated`), se
      // pasan al nuevo, porque siguen siendo válidos para este CUIT hasta que
      // vencen y es la única forma de emitir mientras tanto.
      const oldTickets = await tx.arcaAccessTicket.findMany({
        where: { certFingerprint: oldFingerprint },
      });
      for (const ticket of oldTickets) {
        const keyOf = (certFingerprint: string) => ({
          certFingerprint_service_environment: {
            certFingerprint,
            service: ticket.service,
            environment: ticket.environment,
          },
        });
        const fresh = await tx.arcaAccessTicket.findUnique({
          where: keyOf(cert.fingerprint),
        });
        if (fresh) {
          await tx.arcaAccessTicket.delete({ where: keyOf(oldFingerprint) });
        } else {
          await tx.arcaAccessTicket.update({
            where: keyOf(oldFingerprint),
            data: { certFingerprint: cert.fingerprint },
          });
        }
      }
    });

    await this.audit.record({
      action: AuditActions.ARCA_CERTIFICATE_RENEWED,
      entityType: 'arca_account',
      entityId: account.id,
      actorUserId: user.id,
      tenantId,
      metadata: {
        cuit: account.cuit,
        previousStatus: account.status,
        certExpiresAt: cert.notAfter.toISOString(),
      },
    });
    return this.getAccount(tenantId);
  }

  /**
   * Desvincula (o cancela un wizard a medias). Borra la clave y el
   * certificado, conserva las facturas y pone TODOS los medios en
   * `invoice_mode = none`: el desktop offline decide "se emite al
   * sincronizar" mirando sólo el modo del medio, y un `auto` sin ARCA le
   * mentiría al operario. El update bumpea `sync_seq`, así que baja solo.
   */
  async unlink(tenantId: string, user: User): Promise<void> {
    const account = await this.requireAccount(tenantId);

    await this.prisma.$transaction(async (tx) => {
      await tx.arcaAccount.update({
        where: { id: account.id },
        data: {
          status: 'unlinked',
          csrPem: null,
          ...CLEARED_CERTIFICATE,
          keyEncrypted: null,
          keyVersion: null,
          ptoVta: null,
          linkedAt: null,
        },
      });
      await tx.paymentMethod.updateMany({
        where: { tenantId, invoiceMode: { not: 'none' } },
        data: { invoiceMode: 'none' },
      });

      // El ticket del WSAA es del certificado: se borra sólo si ya no lo usa
      // ninguna otra sede.
      if (account.certFingerprint) {
        const shared = await tx.arcaAccount.count({
          where: {
            certFingerprint: account.certFingerprint,
            id: { not: account.id },
          },
        });
        if (shared === 0) {
          await tx.arcaAccessTicket.deleteMany({
            where: { certFingerprint: account.certFingerprint },
          });
        }
      }
    });

    await this.audit.record({
      action: AuditActions.ARCA_ACCOUNT_UNLINKED,
      entityType: 'arca_account',
      entityId: account.id,
      actorUserId: user.id,
      tenantId,
      metadata: { cuit: account.cuit, previousStatus: account.status },
    });
  }

  // ---------------------------------------------------------------------------

  private async requireAccount(tenantId: string): Promise<ArcaAccount> {
    const account = await this.prisma.arcaAccount.findUnique({
      where: { tenantId },
    });
    if (!account || account.status === 'unlinked') {
      throw this.error(
        HttpStatus.NOT_FOUND,
        'This entity has no ARCA account linked.',
        ErrorCodes.ARCA_NOT_LINKED,
      );
    }
    return account;
  }

  /** La cuenta que emite (o emitía): la única que tiene algo que renovar. */
  private async requireRenewable(tenantId: string): Promise<CertifiedAccount> {
    const account = await this.requireAccount(tenantId);
    if (!ACTIVE_STATUSES.includes(account.status) || !isCertified(account)) {
      throw this.stepInvalid(
        'Only a linked account can renew its certificate.',
      );
    }
    return account;
  }

  /**
   * Login con el certificado nuevo. `alreadyAuthenticated` cuenta como
   * éxito: el WSAA ya validó firma y autorización y sólo se niega a dar un
   * segundo ticket para el alias (el del certificado viejo sigue vivo).
   */
  private async verifyRenewalLogin(
    service: string,
    call: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof ArcaAlreadyAuthenticatedError) return;
      throw this.mapArcaError(error, service);
    }
  }

  private async ownedTenantIds(
    user: User,
    tenantIds: string[],
  ): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    if (this.permissions.isAdmin(user)) return new Set(tenantIds);
    const memberships = await this.prisma.userMembership.findMany({
      where: { userId: user.id, tenantId: { in: tenantIds } },
    });
    return new Set(
      memberships
        .filter((m) => this.permissions.canManageEntity(user, m))
        .map((m) => m.tenantId),
    );
  }

  private credentials(account: CertifiedAccount): ArcaCredentials {
    return {
      cuit: account.cuit,
      certPem: account.certPem,
      keyPem: this.crypto.decrypt(account.keyEncrypted, account.keyVersion),
      certFingerprint: account.certFingerprint,
      environment: account.environment,
    };
  }

  /** Llama a ARCA y traduce sus fallas a errores HTTP del wizard. */
  private async callArca<T>(
    service: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.mapArcaError(error, service);
    }
  }

  private mapArcaError(error: unknown, service: string): FormattedException {
    // Se loguea el mensaje crudo del WSAA: es lo que hace falta para ajustar
    // la clasificación si ARCA cambia sus textos.
    this.logger.warn(
      `ARCA (${service}) rechazó la llamada: ${errorMessage(error)}`,
    );

    if (error instanceof ArcaAuthError) {
      return error.kind === 'not_authorized'
        ? this.error(
            HttpStatus.UNPROCESSABLE_ENTITY,
            `The certificate is not authorized for the "${service}" service: ${error.message}`,
            ErrorCodes.ARCA_CERT_NOT_AUTHORIZED,
          )
        : this.error(
            HttpStatus.UNPROCESSABLE_ENTITY,
            `ARCA rejected the certificate: ${error.message}`,
            ErrorCodes.ARCA_CERT_INVALID,
          );
    }
    if (error instanceof ArcaUnavailableError) {
      return this.error(
        HttpStatus.SERVICE_UNAVAILABLE,
        error.message,
        ErrorCodes.ARCA_UNAVAILABLE,
      );
    }
    this.logger.error(
      `Error inesperado hablando con ARCA: ${errorMessage(error)}`,
    );
    return this.error(
      HttpStatus.SERVICE_UNAVAILABLE,
      errorMessage(error),
      ErrorCodes.ARCA_UNAVAILABLE,
    );
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw this.error(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ARCA invoicing is not configured in this environment (ARCA_ENV).',
        ErrorCodes.ARCA_UNAVAILABLE,
      );
    }
  }

  private posNotFound(ptoVta: number, detail?: string): FormattedException {
    return this.error(
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Sales point ${ptoVta} does not exist in ARCA or is not a web services one.` +
        (detail ? ` ${detail}` : ''),
      ErrorCodes.ARCA_POS_NOT_FOUND,
    );
  }

  private stepInvalid(detail: string): FormattedException {
    return this.error(
      HttpStatus.CONFLICT,
      detail,
      ErrorCodes.ARCA_LINK_STEP_INVALID,
    );
  }

  private error(
    status: HttpStatus,
    detail: string,
    code: ErrorCode,
  ): FormattedException {
    return new FormattedException(
      HTTP_TITLES[status] ?? 'Error',
      status,
      detail,
      INSTANCE,
      code,
    );
  }

  private toDto(account: ArcaAccount): ArcaAccountDto {
    return {
      id: account.id,
      status: account.status,
      environment: account.environment,
      cuit: account.cuit,
      iibb: account.iibb,
      razonSocial: account.razonSocial,
      condicionIva: account.condicionIva,
      domicilioFiscal: account.domicilioFiscal,
      // `@db.Date` llega como 00:00 UTC: el día es el de la parte UTC.
      inicioActividad:
        account.inicioActividad?.toISOString().slice(0, 10) ?? null,
      ptoVta: account.ptoVta,
      ivaRate: Number(account.ivaRate),
      certAlias:
        aliasFromPem(account.certPem) ?? aliasFromPem(account.csrPem) ?? '',
      certExpiresAt: account.certExpiresAt?.toISOString() ?? null,
      renewalPreparedAt: account.renewalPreparedAt?.toISOString() ?? null,
      fiscalDataEditable: account.environment === 'homologacion',
      linkedAt: account.linkedAt?.toISOString() ?? null,
    };
  }
}

const CLEARED_CERTIFICATE = {
  certPem: null,
  certFingerprint: null,
  certExpiresAt: null,
  renewalCsrPem: null,
  renewalKeyEncrypted: null,
  renewalKeyVersion: null,
  renewalPreparedAt: null,
} as const;

const CLEARED_FISCAL_DATA = {
  razonSocial: null,
  condicionIva: null,
  domicilioFiscal: null,
  inicioActividad: null,
} as const;

const HTTP_TITLES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

export function isCertified(account: ArcaAccount): account is CertifiedAccount {
  return (
    !!account.certPem &&
    !!account.keyEncrypted &&
    account.keyVersion !== null &&
    !!account.certFingerprint
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
