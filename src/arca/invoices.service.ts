import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, type ArcaAccount, type Invoice } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PermissionsService } from '../auth/permissions.service';
import { lockArcaAccounts } from './arca-account-lock';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ArcaConfigService } from './arca-config.service';
import { ArcaCryptoService } from './arca-crypto.service';
import { isValidCuit, normalizeCuit } from './arca-cuit';
import { fromArcaDate, toArcaDate } from './arca-dates';
import {
  ARCA_GATEWAY,
  type ArcaCredentials,
  type ArcaGateway,
  ArcaAuthError,
  ArcaUnavailableError,
} from './arca.gateway';
import { InvoiceChangesQueryDto } from './dto/invoice-changes-query.dto';
import { InvoiceChangesResponseDto } from './dto/invoice-changes-response.dto';
import { InvoiceDto } from './dto/invoice.dto';
import { InvoiceSummaryDto } from './dto/invoice-summary.dto';
import { InvoicePreviewDto } from './dto/invoice-preview.dto';
import { lockEntryInvoice } from './entry-invoice-lock';
import type { InvoiceReceiverDto } from './dto/invoice-receiver.dto';
import type { TaxpayerDto } from './dto/taxpayer.dto';
import type {
  InvoiceBatchItemDto,
  InvoiceBatchResponseDto,
} from './dto/issue-invoice-batch.dto';
import {
  CONSUMIDOR_FINAL_ID_THRESHOLD,
  resolveInitialInvoice,
} from './invoice-policy';
import {
  condicionIvaLabel,
  resolveReceiver,
  type PadronReceiver,
} from './invoice-receiver';
import { InvoiceReceiversService } from './invoice-receivers.service';
import { DOC_TIPO_CUIT, letterFor, resolveVoucher } from './resolve-voucher';

/**
 * Un `issuing` más viejo que esto se considera huérfano: la emisión que lo
 * tomó murió o se le cortó la espera, y hay que preguntarle a ARCA cómo quedó.
 * Más corto no: una respuesta de ARCA puede llegar después de nuestro timeout.
 */
export const STALE_ISSUING_MS = 2 * 60_000;

/** Concepto 2 = servicios: una estadía es un servicio con fecha desde/hasta. */
const CONCEPTO_SERVICIOS = 2;

/** Mensajes por defecto para los códigos que se guardan en la factura. */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  INVOICE_RECEIVER_REQUIRED:
    'El monto supera el tope de consumidor final: hay que identificar al receptor.',
  ARCA_CERT_EXPIRED: 'El certificado de ARCA venció: hay que renovarlo.',
  ARCA_CUIT_INVALID: 'El CUIT del receptor no es válido.',
  ARCA_ACCOUNT_UNAVAILABLE:
    'La cuenta elegida ya no está disponible. La factura queda pendiente con su emisor original.',
  INVOICE_RECEIVER_NOT_FOUND:
    'ARCA no tiene datos de ese CUIT: emitila a consumidor final.',
};

/** Campos del receptor que se guardan en la factura antes de emitir. */
function receiverFields(cuit: string | null): {
  receptorDocTipo: number;
  receptorDocNro: string;
  receptorNombre: string | null;
} {
  return cuit
    ? {
        receptorDocTipo: DOC_TIPO_CUIT,
        receptorDocNro: cuit,
        receptorNombre: null,
      }
    : { receptorDocTipo: 99, receptorDocNro: '0', receptorNombre: null };
}

type LinkedAccount = ArcaAccount & {
  cuit: string;
  ptoVta: number;
  certPem: string;
  keyEncrypted: string;
  keyVersion: number;
  certFingerprint: string;
  condicionIva: NonNullable<ArcaAccount['condicionIva']>;
};

export interface CreatedInvoice {
  readonly invoiceId: string;
  /** `true` si hay que emitirla apenas se commitee el cierre. */
  readonly issueNow: boolean;
  /** Por qué quedó pendiente sin intentar emitir (p. ej. certificado vencido). */
  readonly errorCode: ErrorCode | null;
}

/**
 * Facturas de estadías: se crean al cerrar la estadía y se emiten contra ARCA.
 *
 * ## Idempotencia (nunca dos comprobantes para el mismo cobro)
 *
 * 1. `invoices.entry_id` es UNIQUE: una estadía, una factura.
 * 2. Toma atómica: `UPDATE ... WHERE status IN (pending, error, not_required)
 *    → issuing`. Si web y desktop emiten a la vez, uno solo afecta la fila.
 * 3. La numeración va bajo `pg_advisory_xact_lock(cuit, ptoVta, tipo)`: el
 *    lock se tiene durante TODA la emisión, así nadie pide el mismo número.
 * 4. `cbte_nro` se guarda (commit propio, fuera de la transacción del lock)
 *    ANTES de mandar el comprobante. Si la espera se corta, la factura queda
 *    `issuing` con su número y se reconcilia con `getVoucherInfo`: si ARCA la
 *    tiene, pasa a `issued` con su CAE; si no, a `error` y libera el número.
 * 5. `createVoucher` con número explícito, nunca `createNextVoucher` (que
 *    consulta y emite en dos pasos sin lock).
 *
 * ## Qué tira y qué no
 *
 * Los problemas de ARCA (caído, rechazo, certificado vencido) NO son
 * excepciones: quedan en la factura (`status` + `errorCode`) y se devuelven.
 * Sólo tiran los conflictos del request (ya emitida, en curso, no facturable),
 * y únicamente cuando lo pide el endpoint de emisión manual. El cierre de una
 * estadía nunca falla por la factura.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly config: ArcaConfigService,
    private readonly crypto: ArcaCryptoService,
    private readonly receivers: InvoiceReceiversService,
    @Inject(ARCA_GATEWAY) private readonly gateway: ArcaGateway,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Crea la fila de la factura DENTRO de la transacción que cierra la estadía,
   * así estadía cerrada y factura pendiente existen juntas o no existe
   * ninguna. `null` si la playa no factura con ARCA.
   */
  async createForClosedEntry(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly entryId: string;
      readonly total: number;
      readonly paymentMethodIds: readonly (string | null | undefined)[];
      readonly paymentLines?: readonly {
        id: string;
        amount: number;
        paymentMethodId?: string;
      }[];
      readonly selectedPaymentIds?: readonly string[];
      /**
       * CUIT que dio el cliente, tal cual lo mandó el cobro. Un CUIT inválido
       * NO hace fallar el cierre (puede venir de la cola offline): la factura
       * queda pendiente con el motivo.
       */
      readonly receiverCuit?: string | null;
      readonly arcaAccountId?: string;
      readonly userId?: string;
    },
  ): Promise<CreatedInvoice | null> {
    if (!this.config.enabled) return null;

    await lockArcaAccounts(tx, input.tenantId);
    const account = await tx.arcaAccount.findFirst({
      where: {
        tenantId: input.tenantId,
        ...(input.arcaAccountId
          ? { id: input.arcaAccountId }
          : { role: 'primary', status: { not: 'unlinked' } }),
      },
    });
    if (!account) {
      if (input.arcaAccountId) throw this.notLinked(input.entryId);
      return null;
    }
    await this.assertAccountPermission(account, input.userId);
    const unavailable =
      account.environment !== this.config.environment ||
      !['linked', 'cert_expired'].includes(account.status);
    if (unavailable && !input.arcaAccountId) return null;

    const selectedLines = input.selectedPaymentIds
      ? this.selectPaymentLines(
          input.entryId,
          input.paymentLines ?? [],
          input.selectedPaymentIds,
        )
      : input.paymentLines;
    const paymentMethodIds = selectedLines
      ? selectedLines.map((line) => line.paymentMethodId)
      : input.paymentMethodIds;
    const selectedTotal =
      selectedLines && input.selectedPaymentIds
        ? Math.round(
            selectedLines.reduce((sum, line) => sum + line.amount, 0) * 100,
          ) / 100
        : input.total;
    const ids = [
      ...new Set(paymentMethodIds.filter((id): id is string => !!id)),
    ];
    const methods =
      ids.length > 0
        ? await tx.paymentMethod.findMany({
            where: { tenantId: input.tenantId, id: { in: ids } },
            select: { id: true, invoiceMode: true },
          })
        : [];
    const modeById = new Map(methods.map((m) => [m.id, m.invoiceMode]));

    const decision = resolveInitialInvoice({
      total: selectedTotal,
      lineModes: paymentMethodIds.map((id) =>
        id ? (modeById.get(id) ?? 'none') : 'none',
      ),
    });

    // Con cualquier emisor: a un monotributista el CUIT no le cambia la letra
    // (C), pero la factura sale identificada con él.
    const receiverCuit = input.receiverCuit
      ? normalizeCuit(input.receiverCuit)
      : null;
    const receiverInvalid = receiverCuit !== null && !isValidCuit(receiverCuit);

    let status: Invoice['status'] = 'pending';
    let errorCode: ErrorCode | null = null;
    let issueNow = false;
    if (unavailable && selectedTotal > 0) {
      errorCode = ErrorCodes.ARCA_ACCOUNT_UNAVAILABLE;
    } else if (decision.kind === 'not_required') {
      status = 'not_required';
    } else if (decision.kind === 'pending') {
      errorCode = decision.reason ?? null;
    } else if (unavailable) {
      errorCode = ErrorCodes.ARCA_ACCOUNT_UNAVAILABLE;
    } else if (receiverInvalid) {
      errorCode = ErrorCodes.ARCA_CUIT_INVALID;
    } else if (this.isCertExpired(account)) {
      errorCode = ErrorCodes.ARCA_CERT_EXPIRED;
    } else {
      issueNow = true;
    }

    const invoice = await tx.invoice.create({
      data: {
        tenantId: input.tenantId,
        entryId: input.entryId,
        arcaAccountId: account.id,
        emisorCuit: account.cuit,
        emisorRazonSocial: account.razonSocial,
        status,
        errorCode,
        errorMessage: errorCode ? (DEFAULT_MESSAGES[errorCode] ?? null) : null,
        impTotal: selectedTotal,
        selectedPaymentIds: [...(input.selectedPaymentIds ?? [])],
        ...(receiverCuit && status !== 'not_required'
          ? receiverFields(receiverCuit)
          : {}),
      },
      select: { id: true },
    });
    return { invoiceId: invoice.id, issueNow, errorCode };
  }

  /**
   * Emisión después del cierre. Nunca tira: cualquier falla queda en la
   * factura y el cobro sigue.
   */
  async issueAfterClose(
    invoiceId: string,
    userId?: string,
  ): Promise<InvoiceSummaryDto | null> {
    try {
      return await this.issue(invoiceId, userId, { throwOnConflict: false });
    } catch (error) {
      this.logger.error(
        `No se pudo emitir la factura ${invoiceId} después del cierre: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.summaryOrNull(invoiceId);
    }
  }

  /**
   * `POST /tenants/:tenantId/entries/:entryId/invoice`: emite o reintenta.
   * Con `receiverCuit` sale identificada con ese CUIT (la letra la decide el
   * padrón); sin él, B/C a consumidor final, aunque un intento anterior haya
   * sido con CUIT.
   */
  async issueForEntry(
    entryId: string,
    userId?: string,
    receiverCuit?: string,
    expectedAmount?: number,
    selectedPaymentIds?: string[],
    arcaAccountId?: string,
  ): Promise<InvoiceSummaryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const cuit = receiverCuit ? normalizeCuit(receiverCuit) : null;
    if (cuit !== null && !isValidCuit(cuit)) {
      throw new FormattedException(
        'Unprocessable Entity',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The receiver CUIT is not valid.',
        this.instance(entryId),
        ErrorCodes.ARCA_CUIT_INVALID,
      );
    }
    // La cuenta se valida ANTES de crear nada: sin ella, un POST dejaría una
    // factura `pending` huérfana en una playa que no factura.
    const previous = await this.prisma.invoice.findFirst({
      where: { tenantId, entryId },
    });
    const selectedAccountId =
      arcaAccountId ?? previous?.arcaAccountId ?? undefined;
    const selectedAccount = await this.linkedAccount(
      tenantId,
      selectedAccountId,
      previous && (previous.status === 'issuing' || previous.cbteNro !== null)
        ? previous
        : undefined,
    );
    if (!this.config.enabled || !selectedAccount) {
      throw this.notLinked(entryId, selectedAccountId);
    }
    await this.assertAccountPermission(selectedAccount, userId);

    const invoice = await this.prisma.$transaction(async (tx) => {
      await lockEntryInvoice(tx, tenantId, entryId);
      await lockArcaAccounts(tx, tenantId);
      if (!(await this.linkedAccount(tenantId, selectedAccount.id)))
        throw this.notLinked(entryId, selectedAccount.id);
      const entry = await tx.entry.findFirst({
        where: { tenantId, id: entryId, deletedAt: null },
        select: { manuallyInvoiced: true },
      });
      if (entry?.manuallyInvoiced) throw this.externallyIssued(entryId);
      const existing = await tx.invoice.findFirst({
        where: { tenantId, entryId },
      });
      if (!existing || !['issued', 'issuing'].includes(existing.status)) {
        await this.assertInvoiceModeAllowsIssue(
          tx,
          tenantId,
          entryId,
          selectedPaymentIds ?? existing?.selectedPaymentIds,
        );
      }
      if (existing) return existing;
      const amount = await this.resolveAmount(
        tx,
        entryId,
        null,
        selectedPaymentIds,
      );
      this.assertExpectedAmount(entryId, amount, expectedAmount);
      return tx.invoice.create({
        data: {
          tenantId,
          entryId,
          status: 'pending',
          arcaAccountId: selectedAccount.id,
          emisorCuit: selectedAccount.cuit,
          emisorRazonSocial: selectedAccount.razonSocial,
          impTotal: amount,
          selectedPaymentIds: selectedPaymentIds ?? [],
        },
      });
    });

    return this.issue(invoice.id, userId, {
      throwOnConflict: true,
      receiverCuit: cuit,
      expectedAmount,
      selectedPaymentIds,
      arcaAccountId: selectedAccount.id,
    });
  }

  async previewForEntry(
    entryId: string,
    selectedPaymentIds?: string[],
    arcaAccountId?: string,
    userId?: string,
  ): Promise<InvoicePreviewDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const previous = await this.prisma.invoice.findFirst({
      where: { tenantId, entryId },
    });
    const account = await this.linkedAccount(
      tenantId,
      arcaAccountId ?? previous?.arcaAccountId ?? undefined,
    );
    if (!this.config.enabled || !account) {
      throw this.notLinked(
        entryId,
        arcaAccountId ?? previous?.arcaAccountId ?? undefined,
      );
    }
    await this.assertAccountPermission(account, userId);
    if (previous) this.assertEmitterChange(previous, account);
    return this.prisma.$transaction(async (tx) => {
      await lockEntryInvoice(tx, tenantId, entryId);
      const entry = await tx.entry.findFirst({
        where: { tenantId, id: entryId, deletedAt: null },
        select: { manuallyInvoiced: true },
      });
      if (entry?.manuallyInvoiced) throw this.externallyIssued(entryId);
      const invoice = await tx.invoice.findFirst({
        where: { tenantId, entryId },
      });
      if (!invoice || !['issued', 'issuing'].includes(invoice.status)) {
        await this.assertInvoiceModeAllowsIssue(
          tx,
          tenantId,
          entryId,
          selectedPaymentIds ?? invoice?.selectedPaymentIds,
        );
      }
      const amount = await this.resolveAmount(
        tx,
        entryId,
        invoice,
        selectedPaymentIds,
      );
      const conflict = invoice
        ? this.conflictFor({ ...invoice, impTotal: new Prisma.Decimal(amount) })
        : null;
      if (conflict) throw conflict;
      return { amount };
    });
  }

  async updatePendingAmount(
    tx: Prisma.TransactionClient,
    entryId: string,
    amount: number,
  ): Promise<void> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    await tx.invoice.updateMany({
      where: {
        tenantId,
        entryId,
        status: { in: ['pending', 'error', 'not_required'] },
        cbteNro: null,
      },
      data: { impTotal: amount, selectedPaymentIds: [] },
    });
  }

  async markExternallyIssued(
    tx: Prisma.TransactionClient,
    tenantId: string,
    entryId: string,
  ): Promise<void> {
    const invoice = await tx.invoice.findFirst({
      where: { tenantId, entryId },
    });
    if (!invoice) return;
    if (invoice.status === 'issued') throw this.externallyIssued(entryId);
    if (invoice.status === 'issuing' || invoice.cbteNro !== null) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Invoice issuance is in progress; resolve it before registering an external invoice.',
        this.instance(entryId),
        ErrorCodes.INVOICE_IN_PROGRESS,
      );
    }
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'not_required',
        errorCode: null,
        errorMessage: null,
        issuingStartedAt: null,
      },
    });
  }

  private async assertInvoiceModeAllowsIssue(
    tx: Prisma.TransactionClient,
    tenantId: string,
    entryId: string,
    selectedPaymentIds?: readonly string[],
  ): Promise<void> {
    const lines = await tx.paymentTransaction.findMany({
      where: { tenantId, entryId, deletedAt: null },
      select: { id: true, paymentMethodId: true },
    });
    const selected = selectedPaymentIds?.length
      ? this.selectPaymentLines(entryId, lines, selectedPaymentIds)
      : lines;
    const ids = [
      ...new Set(
        selected
          .map((line) => line.paymentMethodId)
          .filter((id): id is string => !!id),
      ),
    ];
    const methods = await tx.paymentMethod.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, invoiceMode: true },
    });
    const modeById = new Map(
      methods.map((method) => [method.id, method.invoiceMode]),
    );
    if (
      selected.length === 0 ||
      selected.some((line) =>
        line.paymentMethodId
          ? (modeById.get(line.paymentMethodId) ?? 'none') === 'none'
          : true,
      )
    ) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Invoicing is disabled for this payment method.',
        this.instance(entryId),
        ErrorCodes.INVOICE_MODE_DISABLED,
      );
    }
  }

  private async resolveAmount(
    tx: Prisma.TransactionClient,
    entryId: string,
    invoice: Invoice | null,
    selectedPaymentIds?: readonly string[],
  ): Promise<number> {
    // An uncertain ARCA request must be reconciled using its original snapshot.
    if (
      invoice &&
      (invoice.status === 'issued' ||
        invoice.status === 'issuing' ||
        invoice.cbteNro !== null)
    ) {
      return Number(invoice.impTotal);
    }
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const entry = await tx.entry.findFirst({
      where: { tenantId, id: entryId, deletedAt: null },
      select: { leftAt: true, amountPaid: true },
    });
    if (!entry) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Entry ${entryId} not found in this entity.`,
        this.instance(entryId),
        ErrorCodes.NOT_FOUND,
      );
    }
    const amount = Number(entry.amountPaid);
    if (!entry.leftAt || !Number.isFinite(amount) || !(amount > 0)) {
      throw this.notInvoiceable(entryId);
    }
    const ids = selectedPaymentIds ?? invoice?.selectedPaymentIds ?? [];
    if (ids.length === 0) return Math.round(amount * 100) / 100;
    const lines = await tx.paymentTransaction.findMany({
      where: { tenantId, entryId, deletedAt: null },
      select: { id: true, amount: true },
    });
    const selected = this.selectPaymentLines(entryId, lines, ids);
    const selectedAmount = selected.reduce(
      (sum, line) => sum + Number(line.amount),
      0,
    );
    if (!(selectedAmount > 0) || selectedAmount > amount + 0.005) {
      throw this.selectionChanged(entryId);
    }
    return Math.round(selectedAmount * 100) / 100;
  }

  private selectPaymentLines<T extends { id: string }>(
    entryId: string,
    lines: readonly T[],
    selectedIds: readonly string[],
  ): T[] {
    const ids = new Set(selectedIds);
    if (ids.size === 0 || ids.size !== selectedIds.length) {
      throw this.selectionChanged(entryId);
    }
    const selected = lines.filter((line) => ids.has(line.id));
    if (selected.length !== ids.size) throw this.selectionChanged(entryId);
    return selected;
  }

  private selectionChanged(entryId: string): FormattedException {
    return new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      'The selected payments changed. Review the invoice amount before retrying.',
      this.instance(entryId),
      ErrorCodes.INVOICE_AMOUNT_CHANGED,
    );
  }

  private assertExpectedAmount(
    entryId: string,
    amount: number,
    expected?: number,
  ): void {
    if (
      expected !== undefined &&
      Math.round(expected * 100) !== Math.round(amount * 100)
    ) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'The invoice amount changed. Confirm the current amount before retrying.',
        this.instance(entryId),
        ErrorCodes.INVOICE_AMOUNT_CHANGED,
      );
    }
  }

  /**
   * `POST /tenants/:tenantId/invoices/batch`: emite a consumidor final, de a
   * una y en orden, y devuelve cómo quedó cada estadía. Un conflicto de una
   * (ya emitida, no facturable) no corta el lote.
   *
   * Si ARCA no responde, las que faltan no se intentan: cada intento esperaría
   * el timeout entero y el request no terminaría nunca. Vuelven con
   * `ARCA_UNAVAILABLE` y sin factura, para reintentar después.
   */
  async issueBatch(
    entryIds: readonly string[],
    userId?: string,
    arcaAccountId?: string,
  ): Promise<InvoiceBatchResponseDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const account = await this.linkedAccount(tenantId, arcaAccountId);
    if (!this.config.enabled || !account) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'This entity has no ARCA account linked.',
        '/tenants/:tenantId/invoices/batch',
        ErrorCodes.ARCA_NOT_LINKED,
      );
    }
    await this.assertAccountPermission(account, userId);

    const results: InvoiceBatchItemDto[] = [];
    let arcaDown = false;
    for (const entryId of entryIds) {
      if (arcaDown) {
        results.push({
          entryId,
          invoice: null,
          errorCode: ErrorCodes.ARCA_UNAVAILABLE,
        });
        continue;
      }
      try {
        const invoice = await this.issueForEntry(
          entryId,
          userId,
          undefined,
          undefined,
          undefined,
          arcaAccountId,
        );
        results.push({
          entryId,
          invoice,
          errorCode: invoice.status === 'issued' ? null : invoice.errorCode,
        });
        arcaDown = invoice.errorCode === ErrorCodes.ARCA_UNAVAILABLE;
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const body = error.getResponse();
        results.push({
          entryId,
          invoice: null,
          errorCode:
            typeof body === 'object' && 'code' in body
              ? String(body.code)
              : ErrorCodes.INTERNAL_ERROR,
        });
      }
    }
    return { results };
  }

  /**
   * `GET /tenants/:tenantId/arca/taxpayers/:cuit`: qué factura sale con este
   * CUIT, para mostrárselo al operario antes de emitir. Usa (y llena) la
   * misma caché que la emisión, así la letra que ve es la que sale.
   */
  async lookupTaxpayer(
    rawCuit: string,
    arcaAccountId?: string,
    userId?: string,
  ): Promise<TaxpayerDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const instance = '/tenants/:tenantId/arca/taxpayers/:cuit';
    const cuit = normalizeCuit(rawCuit);
    if (!isValidCuit(cuit)) {
      throw new FormattedException(
        'Unprocessable Entity',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The CUIT is not valid.',
        instance,
        ErrorCodes.ARCA_CUIT_INVALID,
      );
    }
    const account = this.config.enabled
      ? await this.linkedAccount(tenantId, arcaAccountId)
      : null;
    if (!account) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'This entity has no ARCA account linked.',
        instance,
        ErrorCodes.ARCA_NOT_LINKED,
      );
    }

    await this.assertAccountPermission(account, userId);

    let padron: PadronReceiver;
    try {
      padron = await this.receivers.lookup(tenantId, cuit, () =>
        this.audited(
          { id: null, tenantId },
          'getTaxpayerDetails',
          { cuit },
          () =>
            this.gateway.getTaxpayerDetails(this.credentials(account), cuit),
        ),
      );
    } catch (error) {
      const code = arcaFailureCode(error);
      throw new FormattedException(
        code === ErrorCodes.ARCA_UNAVAILABLE
          ? 'Service Unavailable'
          : 'Unprocessable Entity',
        code === ErrorCodes.ARCA_UNAVAILABLE
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.UNPROCESSABLE_ENTITY,
        error instanceof Error ? error.message : String(error),
        instance,
        code,
      );
    }

    const resolution = resolveReceiver({
      cuit,
      padron,
      environment: account.environment,
    });
    const condicion = resolution.ok ? resolution.condicionIvaReceptorId : null;
    return {
      cuit,
      identified: resolution.ok,
      letter: letterFor(account.condicionIva, condicion),
      razonSocial: padron.razonSocial,
      condicionIvaReceptorId: condicion,
      condicionIva: condicion === null ? null : condicionIvaLabel(condicion),
      assumed: resolution.ok && resolution.assumed,
    };
  }

  /** `GET /tenants/:tenantId/invoice-receivers`: CUIT ya facturados. */
  async receiverSuggestions(
    q: string | undefined,
    limit: number,
  ): Promise<InvoiceReceiverDto[]> {
    return this.receivers.suggestions(
      this.tenantContext.getTenantIdOrThrow(),
      q,
      limit,
    );
  }

  async pullChanges(
    query: InvoiceChangesQueryDto,
  ): Promise<InvoiceChangesResponseDto> {
    const items = await this.prisma.getTenantClient().invoice.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toInvoiceDto), maxSeq };
  }

  async summaryOrNull(invoiceId: string): Promise<InvoiceSummaryDto | null> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    return invoice ? toSummary(invoice) : null;
  }

  /**
   * Para el job diario: resuelve las facturas trabadas en `issuing` más de
   * `olderThanMs`, de cualquier playa. Es la misma reconciliación que hace la
   * emisión antes de numerar, pero sin esperar a que alguien vuelva a emitir
   * con esa numeración (una playa que factura poco podría no hacerlo nunca).
   *
   * Corre sin tenant en contexto: cliente crudo y filtro explícito. Nunca
   * tira; lo que no se pudo resolver queda para la próxima corrida.
   */
  async reconcileStaleIssuing(input: {
    readonly olderThanMs: number;
    readonly limit: number;
  }): Promise<{ readonly reconciled: number; readonly failed: number }> {
    if (!this.config.enabled) return { reconciled: 0, failed: 0 };
    const stale = await this.prisma.invoice.findMany({
      where: {
        status: 'issuing',
        issuingStartedAt: { lt: new Date(Date.now() - input.olderThanMs) },
      },
      orderBy: { issuingStartedAt: 'asc' },
      take: input.limit,
    });

    let reconciled = 0;
    let failed = 0;
    for (const invoice of stale) {
      try {
        // Sin número, el proceso murió antes de mandar nada: no hay nada que
        // preguntarle a ARCA, se libera para reintentar.
        if (invoice.cbteNro === null) {
          await this.markError(
            invoice.id,
            ErrorCodes.ARCA_UNAVAILABLE,
            'La emisión se interrumpió antes de llegar a ARCA. Reintentá.',
          );
          reconciled++;
          continue;
        }
        const account = await this.linkedAccount(
          invoice.tenantId,
          invoice.arcaAccountId ?? undefined,
          invoice,
        );
        if (
          !account ||
          invoice.environment === null ||
          invoice.emisorCuit === null ||
          invoice.ptoVta === null ||
          invoice.cbteTipo === null
        ) {
          failed++;
          continue;
        }
        const creds = this.credentials(account);
        const lockKey = numberingLockKey({
          environment: invoice.environment,
          emisorCuit: invoice.emisorCuit,
          ptoVta: invoice.ptoVta,
          cbteTipo: invoice.cbteTipo,
        });
        await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
            // Mientras esperaba el lock, una emisión pudo haberla resuelto.
            const fresh = await tx.invoice.findUniqueOrThrow({
              where: { id: invoice.id },
            });
            if (fresh.status !== 'issuing' || fresh.cbteNro === null) return;
            await this.reconcile(fresh, creds);
          },
          { timeout: this.config.timeoutMs * 2 + 10_000 },
        );
        reconciled++;
      } catch (error) {
        failed++;
        this.logger.warn(
          `No se pudo reconciliar la factura ${invoice.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { reconciled, failed };
  }

  /** `true` si la estadía tiene una factura emitida o en curso en ARCA. */
  async hasIssuedInvoice(
    tx: Prisma.TransactionClient,
    tenantId: string,
    entryId: string,
  ): Promise<boolean> {
    const invoice = await tx.invoice.findFirst({
      where: {
        tenantId,
        entryId,
        OR: [
          { status: { in: ['issued', 'issuing'] } },
          { cbteNro: { not: null } },
        ],
      },
      select: { id: true },
    });
    return invoice !== null;
  }

  private async issue(
    invoiceId: string,
    userId: string | undefined,
    opts: {
      readonly throwOnConflict: boolean;
      readonly receiverCuit?: string | null;
      readonly expectedAmount?: number;
      readonly selectedPaymentIds?: readonly string[];
      readonly arcaAccountId?: string;
    },
  ): Promise<InvoiceSummaryDto> {
    const tenantId = this.tenantContext.getTenantIdOrThrow();
    const current = await this.prisma.invoice.findFirstOrThrow({
      where: { id: invoiceId, tenantId },
    });

    const prepared = await this.prisma.$transaction(async (tx) => {
      await lockEntryInvoice(tx, tenantId, current.entryId);
      await lockArcaAccounts(tx, tenantId);
      const activeEntry = await tx.entry.findFirst({
        where: { tenantId, id: current.entryId, deletedAt: null },
        select: { id: true, manuallyInvoiced: true },
      });
      if (!activeEntry) throw this.notInvoiceable(current.entryId);
      if (activeEntry.manuallyInvoiced) {
        if (opts.throwOnConflict) throw this.externallyIssued(current.entryId);
        const invoice = await tx.invoice.findFirstOrThrow({
          where: { id: invoiceId, tenantId },
        });
        return { invoice, claimed: false };
      }
      let fresh = await tx.invoice.findFirstOrThrow({
        where: { id: invoiceId, tenantId },
      });
      const selectedId = opts.arcaAccountId ?? fresh.arcaAccountId ?? undefined;
      const account = await this.linkedAccount(
        tenantId,
        selectedId,
        fresh.status === 'issuing' || fresh.cbteNro !== null
          ? fresh
          : undefined,
      );
      if (!account) {
        if (opts.throwOnConflict)
          throw this.notLinked(current.entryId, selectedId);
        if (fresh.status !== 'issuing' && fresh.status !== 'issued')
          fresh = await tx.invoice.update({
            where: { id: invoiceId },
            data: {
              status: 'pending',
              errorCode: ErrorCodes.ARCA_ACCOUNT_UNAVAILABLE,
            },
          });
        return { invoice: fresh, claimed: false };
      }
      await this.assertAccountPermission(account, userId);
      this.assertEmitterChange(fresh, account);
      // Resolve and validate under the same lock used by history corrections.
      const amount = await this.resolveAmount(
        tx,
        fresh.entryId,
        fresh,
        opts.selectedPaymentIds,
      );
      const conflict = this.conflictFor({
        ...fresh,
        impTotal: new Prisma.Decimal(amount),
      });
      if (conflict) {
        if (opts.throwOnConflict) throw conflict;
        return { invoice: fresh, claimed: false };
      }
      this.assertExpectedAmount(fresh.entryId, amount, opts.expectedAmount);
      if (fresh.status !== 'issuing' && fresh.cbteNro === null) {
        fresh = await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            arcaAccountId: account.id,
            emisorCuit: account.cuit,
            emisorRazonSocial: account.razonSocial,
            impTotal: amount,
            ...(opts.selectedPaymentIds !== undefined
              ? { selectedPaymentIds: [...opts.selectedPaymentIds] }
              : {}),
            ...(opts.receiverCuit !== undefined
              ? receiverFields(opts.receiverCuit)
              : {}),
          },
        });
      }

      const pendingCode =
        amount >= CONSUMIDOR_FINAL_ID_THRESHOLD &&
        fresh.receptorDocTipo !== DOC_TIPO_CUIT
          ? ErrorCodes.INVOICE_RECEIVER_REQUIRED
          : this.isCertExpired(account)
            ? ErrorCodes.ARCA_CERT_EXPIRED
            : null;
      if (pendingCode) {
        // Do not release an uncertain attempt: its reconciliation still owns the snapshot.
        if (fresh.status !== 'issuing') {
          fresh = await tx.invoice.update({
            where: { id: invoiceId },
            data: {
              status: 'pending',
              errorCode: pendingCode,
              errorMessage: DEFAULT_MESSAGES[pendingCode] ?? null,
            },
          });
        }
        return { invoice: fresh, claimed: false, pendingCode };
      }

      const now = new Date();
      const claimed = await tx.invoice.updateMany({
        where: {
          id: invoiceId,
          tenantId,
          OR: [
            { status: { in: ['pending', 'error', 'not_required'] } },
            {
              status: 'issuing',
              issuingStartedAt: {
                lt: new Date(now.getTime() - STALE_ISSUING_MS),
              },
            },
          ],
        },
        data: {
          status: 'issuing',
          issuingStartedAt: now,
          attempts: { increment: 1 },
          errorCode: null,
          errorMessage: null,
          issuedByUserId: userId ?? null,
        },
      });
      fresh = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (claimed.count === 0) {
        const raced = this.conflictFor(fresh);
        if (raced && opts.throwOnConflict) throw raced;
      }
      return { invoice: fresh, claimed: claimed.count > 0, account };
    });
    if (!prepared.claimed) {
      if (
        prepared.pendingCode === ErrorCodes.INVOICE_RECEIVER_REQUIRED &&
        opts.throwOnConflict
      ) {
        throw new FormattedException(
          'Unprocessable Entity',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Consumer-final invoices above the threshold require a receiver.',
          this.instance(current.entryId),
          ErrorCodes.INVOICE_RECEIVER_REQUIRED,
        );
      }
      return toSummary(prepared.invoice);
    }

    await this.emit(prepared.invoice, prepared.account!);
    return toSummary(
      await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
    );
  }

  /**
   * La emisión propiamente dicha, con la factura ya tomada (`issuing`).
   * Deja la factura en `issued`, `error` o —si la espera se cortó después de
   * mandar— en `issuing` para reconciliar.
   */
  private async emit(invoice: Invoice, account: LinkedAccount): Promise<void> {
    const creds = this.credentials(account);
    const receiver = await this.resolveReceiverFor(invoice, account, creds);
    if (receiver === 'failed') return;
    const voucher = resolveVoucher({
      emitter: account.condicionIva,
      total: Number(invoice.impTotal),
      ivaRate: Number(account.ivaRate),
      receiver: receiver ?? undefined,
    });
    const key = {
      environment: account.environment,
      emisorCuit: account.cuit,
      ptoVta: account.ptoVta,
      cbteTipo: voucher.cbteTipo,
    };
    const lockKey = numberingLockKey(key);
    let sent = false;

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

          // 1. Esta misma factura pudo haber quedado a medias en un intento
          //    anterior: si ARCA la tiene, ya está, no se emite otra.
          //    Si no la tiene, sólo se libera el número: la factura sigue
          //    `issuing` (tomada por nosotros) hasta terminar.
          if (invoice.status === 'issuing' && invoice.cbteNro !== null) {
            if (await this.reconcile(invoice, creds, 'release')) return;
          }

          // 2. Otras facturas a medias con la misma numeración.
          if (await this.reconcileOthers(invoice.id, key, creds)) {
            await this.markError(
              invoice.id,
              ErrorCodes.ARCA_UNAVAILABLE,
              'Hay otra factura esperando respuesta de ARCA con esta numeración. Reintentá en unos minutos.',
            );
            return;
          }

          const last = await this.audited(
            invoice,
            'getLastVoucher',
            { ptoVta: key.ptoVta, cbteTipo: key.cbteTipo },
            () => this.gateway.getLastVoucher(creds, key.ptoVta, key.cbteTipo),
          );
          const cbteNro = last + 1;
          const today = toArcaDate(new Date());
          const entry = await tx.entry.findUniqueOrThrow({
            where: { id: invoice.entryId },
            select: { enteredAt: true, leftAt: true },
          });
          const fchServDesde = toArcaDate(entry.enteredAt);
          const fchServHasta = toArcaDate(entry.leftAt ?? new Date());

          // Commit propio, FUERA de la transacción del lock: si el proceso
          // muere después de mandar, el número tiene que haber quedado.
          await this.prisma.invoice.update({
            where: { id: invoice.id },
            data: {
              ...key,
              cbteNro,
              cbteFch: fromArcaDate(today),
              fchServDesde: fromArcaDate(fchServDesde),
              fchServHasta: fromArcaDate(fchServHasta),
              receptorDocTipo: voucher.docTipo,
              receptorDocNro: String(voucher.docNro),
              receptorNombre: receiver?.nombre ?? 'Consumidor Final',
              receptorCondicionIvaId: voucher.condicionIvaReceptorId,
              impNeto: voucher.impNeto,
              impIva: voucher.impIva,
              ivaRate: voucher.iva ? account.ivaRate : null,
              emisorRazonSocial: account.razonSocial,
              emisorDomicilio: account.domicilioFiscal,
              emisorCondicionIva: account.condicionIva,
              emisorIibb: account.iibb,
              emisorInicioActividad: account.inicioActividad,
            },
          });

          const request = {
            PtoVta: key.ptoVta,
            CbteTipo: key.cbteTipo,
            Concepto: CONCEPTO_SERVICIOS,
            DocTipo: voucher.docTipo,
            DocNro: voucher.docNro,
            CbteDesde: cbteNro,
            CbteHasta: cbteNro,
            CbteFch: today,
            FchServDesde: fchServDesde,
            FchServHasta: fchServHasta,
            FchVtoPago: today,
            ImpTotal: voucher.impTotal,
            ImpTotConc: 0,
            ImpNeto: voucher.impNeto,
            ImpOpEx: 0,
            ImpIVA: voucher.impIva,
            ImpTrib: 0,
            MonId: 'PES',
            MonCotiz: 1,
            CondicionIVAReceptorId: voucher.condicionIvaReceptorId,
            ...(voucher.iva && { Iva: voucher.iva }),
          };
          sent = true;
          const result = await this.audited(
            invoice,
            'createVoucher',
            request,
            () => this.gateway.createVoucher(creds, request),
            (r) => r.raw,
          );

          if (result.approved) {
            await this.prisma.invoice.update({
              where: { id: invoice.id },
              data: {
                status: 'issued',
                cae: result.cae,
                caeVto: fromArcaDate(result.caeVto),
                issuedAt: new Date(),
              },
            });
            if (receiver) {
              await this.receivers.markUsed(invoice.tenantId, receiver.cuit);
            }
            return;
          }

          await this.markError(
            invoice.id,
            ErrorCodes.INVOICE_REJECTED,
            result.messages
              .map((m) => (m.code ? `${m.code}: ${m.msg}` : m.msg))
              .join(' | ') || 'ARCA rechazó el comprobante.',
          );
        },
        { timeout: this.config.timeoutMs * 6 + 10_000 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unknownOutcome =
        sent &&
        (!(error instanceof ArcaUnavailableError) || error.outcomeUnknown);
      if (unknownOutcome) {
        // Pudo haber llegado: queda `issuing` con su número y se reconcilia.
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            errorCode: ErrorCodes.ARCA_UNAVAILABLE,
            errorMessage: `ARCA no confirmó el comprobante (${message}). Se verifica al reintentar.`,
          },
        });
        return;
      }
      this.logger.warn(`Factura ${invoice.id} no emitida: ${message}`);
      await this.markError(invoice.id, arcaFailureCode(error), message);
    }
  }

  /**
   * El receptor identificado con CUIT, con la condición del padrón (de la
   * caché si el operario ya lo consultó al tipearlo). `null` si la factura es
   * a consumidor final; `'failed'` si no se puede emitir (la factura ya quedó
   * en `error` con el motivo).
   */
  private async resolveReceiverFor(
    invoice: Invoice,
    account: LinkedAccount,
    creds: ArcaCredentials,
  ): Promise<
    | { cuit: string; condicionIvaReceptorId: number; nombre: string }
    | null
    | 'failed'
  > {
    const cuit = invoice.receptorDocNro;
    if (invoice.receptorDocTipo !== DOC_TIPO_CUIT || !cuit) return null;

    let padron: PadronReceiver;
    try {
      padron = await this.receivers.lookup(invoice.tenantId, cuit, () =>
        this.audited(invoice, 'getTaxpayerDetails', { cuit }, () =>
          this.gateway.getTaxpayerDetails(creds, cuit),
        ),
      );
    } catch (error) {
      await this.markError(
        invoice.id,
        arcaFailureCode(error),
        error instanceof Error ? error.message : String(error),
      );
      return 'failed';
    }

    const resolution = resolveReceiver({
      cuit,
      padron,
      environment: account.environment,
    });
    if (!resolution.ok) {
      await this.markError(
        invoice.id,
        resolution.code,
        DEFAULT_MESSAGES[resolution.code] ?? resolution.code,
      );
      return 'failed';
    }
    return {
      cuit,
      condicionIvaReceptorId: resolution.condicionIvaReceptorId,
      nombre: resolution.nombre,
    };
  }

  /**
   * Resuelve una factura `issuing` con número preguntándole a ARCA. `true` si
   * ARCA la tiene (quedó `issued`). Si no la tiene, libera el número y la deja
   * en `error` (`onMissing = 'error'`) o todavía `issuing` (`'release'`, para
   * la factura que se está emitiendo en este mismo request).
   * Si ARCA no responde, tira: sin saber cómo quedó no se puede numerar.
   */
  private async reconcile(
    invoice: Invoice,
    creds: ArcaCredentials,
    onMissing: 'error' | 'release' = 'error',
  ): Promise<boolean> {
    const info = await this.audited(
      invoice,
      'getVoucherInfo',
      {
        cbteNro: invoice.cbteNro,
        ptoVta: invoice.ptoVta,
        cbteTipo: invoice.cbteTipo,
      },
      () =>
        this.gateway.getVoucherInfo(
          creds,
          invoice.cbteNro!,
          invoice.ptoVta!,
          invoice.cbteTipo!,
        ),
    );

    // El importe tiene que coincidir: un comprobante con ese número pero otro
    // total no es esta factura (lo emitió otro sistema con el mismo punto de
    // venta) y adjudicárselo sería mentir.
    if (
      info &&
      (info.impTotal === undefined ||
        Math.abs(info.impTotal - Number(invoice.impTotal)) < 0.005)
    ) {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'issued',
          cae: info.cae,
          caeVto: fromArcaDate(info.caeVto),
          issuedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      return true;
    }

    if (onMissing === 'release') {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { cbteNro: null },
      });
      return false;
    }
    await this.markError(
      invoice.id,
      ErrorCodes.ARCA_UNAVAILABLE,
      'ARCA no registró el comprobante. Reintentá la emisión.',
    );
    return false;
  }

  /**
   * Reconcilia las otras `issuing` de la misma numeración. `true` si hay una
   * todavía joven (su respuesta puede estar en viaje): numerar ahora podría
   * pisarle el número, así que no se emite.
   */
  private async reconcileOthers(
    invoiceId: string,
    key: {
      environment: Invoice['environment'];
      emisorCuit: string;
      ptoVta: number;
      cbteTipo: number;
    },
    creds: ArcaCredentials,
  ): Promise<boolean> {
    // Cliente crudo a propósito: la misma numeración puede cruzar playas que
    // comparten CUIT, y el filtro es la clave de numeración, no la playa.
    const others = await this.prisma.invoice.findMany({
      where: {
        ...key,
        status: 'issuing',
        cbteNro: { not: null },
        id: { not: invoiceId },
      },
    });
    const cutoff = Date.now() - STALE_ISSUING_MS;
    for (const other of others) {
      if ((other.issuingStartedAt?.getTime() ?? 0) > cutoff) return true;
      await this.reconcile(other, creds);
    }
    return false;
  }

  /** Llama a ARCA y deja el request, la respuesta y la duración en `arca_requests`. */
  private async audited<T>(
    invoice: { readonly id: string | null; readonly tenantId: string },
    operation: string,
    request: unknown,
    call: () => Promise<T>,
    toJson: (result: T) => unknown = (result) => result,
  ): Promise<T> {
    const started = Date.now();
    let response: unknown;
    let failure: string | undefined;
    try {
      const result = await call();
      response = toJson(result);
      return result;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.prisma.arcaRequest
        .create({
          data: {
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            operation,
            requestJson: toJsonValue(request),
            responseJson: toJsonValue(response),
            error: failure ?? null,
            durationMs: Date.now() - started,
          },
        })
        .catch((error: unknown) =>
          this.logger.warn(
            `No se pudo auditar ${operation}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }
  }

  private async linkedAccount(
    tenantId: string,
    accountId?: string,
    original?: Invoice,
  ): Promise<LinkedAccount | null> {
    if (
      !accountId &&
      original &&
      !original.emisorCuit &&
      (original.status === 'issuing' || original.cbteNro !== null)
    )
      return null;
    const account = await this.prisma.arcaAccount.findFirst({
      where: {
        tenantId,
        ...(accountId
          ? { id: accountId }
          : original?.emisorCuit
            ? {
                cuit: original.emisorCuit,
                ptoVta: original.ptoVta,
                environment: original.environment ?? undefined,
              }
            : { role: 'primary' }),
        status: { not: 'unlinked' },
      },
    });
    if (
      !account ||
      account.environment !== this.config.environment ||
      (account.status !== 'linked' && account.status !== 'cert_expired') ||
      !account.ptoVta ||
      !account.certPem ||
      !account.keyEncrypted ||
      account.keyVersion === null ||
      !account.certFingerprint ||
      !account.condicionIva
    ) {
      return null;
    }
    return account as LinkedAccount;
  }

  private assertEmitterChange(invoice: Invoice, account: ArcaAccount): void {
    const changed = invoice.arcaAccountId
      ? invoice.arcaAccountId !== account.id
      : !invoice.emisorCuit ||
        invoice.emisorCuit !== account.cuit ||
        invoice.ptoVta !== account.ptoVta ||
        (invoice.environment !== null &&
          invoice.environment !== account.environment);
    if (
      changed &&
      (invoice.status === 'issuing' ||
        invoice.status === 'issued' ||
        invoice.cbteNro !== null)
    ) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'The original issuer must resolve this invoice first.',
        this.instance(invoice.entryId),
        ErrorCodes.INVOICE_EMITTER_LOCKED,
      );
    }
  }

  private async assertAccountPermission(
    account: ArcaAccount,
    userId?: string,
  ): Promise<void> {
    if (account.role !== 'secondary') return;
    const user = userId
      ? await this.prisma.user.findUnique({ where: { id: userId } })
      : null;
    const membership = user
      ? await this.prisma.userMembership.findUnique({
          where: {
            userId_tenantId: { userId: user.id, tenantId: account.tenantId },
          },
        })
      : null;
    if (!user || !this.permissions.canManageEntity(user, membership)) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Only the owner can invoice with a secondary account.',
        '/tenants/:tenantId/arca/accounts',
        ErrorCodes.ENTITY_INSUFFICIENT_ROLE,
      );
    }
  }

  private credentials(account: LinkedAccount): ArcaCredentials {
    return {
      cuit: account.cuit,
      certPem: account.certPem,
      keyPem: this.crypto.decrypt(account.keyEncrypted, account.keyVersion),
      certFingerprint: account.certFingerprint,
      environment: account.environment,
    };
  }

  private isCertExpired(account: {
    status: ArcaAccount['status'];
    certExpiresAt: Date | null;
  }): boolean {
    return (
      account.status === 'cert_expired' ||
      (account.certExpiresAt !== null &&
        account.certExpiresAt.getTime() <= Date.now())
    );
  }

  private conflictFor(invoice: Invoice): FormattedException | null {
    if (invoice.status === 'issued') {
      return new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'The entry already has an issued invoice.',
        this.instance(invoice.entryId),
        ErrorCodes.INVOICE_ALREADY_ISSUED,
      );
    }
    const stale =
      (invoice.issuingStartedAt?.getTime() ?? 0) <
      Date.now() - STALE_ISSUING_MS;
    if (invoice.status === 'issuing' && !stale) {
      return new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'The invoice is being issued right now.',
        this.instance(invoice.entryId),
        ErrorCodes.INVOICE_IN_PROGRESS,
      );
    }
    if (!(Number(invoice.impTotal) > 0))
      return this.notInvoiceable(invoice.entryId);
    return null;
  }

  private async markError(
    invoiceId: string,
    code: ErrorCode,
    message: string,
  ): Promise<void> {
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'error',
        cbteNro: null,
        errorCode: code,
        errorMessage: message,
      },
    });
  }

  private notLinked(entryId: string, selectedId?: string): FormattedException {
    return new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      selectedId
        ? 'The selected ARCA account is no longer available.'
        : 'This entity has no ARCA account linked.',
      this.instance(entryId),
      selectedId
        ? ErrorCodes.ARCA_ACCOUNT_UNAVAILABLE
        : ErrorCodes.ARCA_NOT_LINKED,
    );
  }

  private notInvoiceable(entryId: string): FormattedException {
    return new FormattedException(
      'Unprocessable Entity',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'The entry is still open or was charged $0.',
      this.instance(entryId),
      ErrorCodes.INVOICE_NOT_INVOICEABLE,
    );
  }

  private externallyIssued(entryId: string): FormattedException {
    return new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      'This stay already has an invoice issued outside Parkit.',
      this.instance(entryId),
      ErrorCodes.INVOICE_ALREADY_ISSUED,
    );
  }

  private instance(entryId: string): string {
    return `/tenants/:tenantId/entries/${entryId}/invoice`;
  }
}

/**
 * Código de una falla de ARCA: un certificado sin el servicio asociado no se
 * arregla reintentando (el dueño tiene que ir a ARCA); el resto, sí.
 */
function arcaFailureCode(error: unknown): ErrorCode {
  return error instanceof ArcaAuthError && error.kind === 'not_authorized'
    ? ErrorCodes.ARCA_CERT_NOT_AUTHORIZED
    : ErrorCodes.ARCA_UNAVAILABLE;
}

/**
 * El lock que serializa la numeración: uno por (entorno, CUIT, punto de
 * venta, tipo), que es lo que numera ARCA.
 */
function numberingLockKey(key: {
  environment: string;
  emisorCuit: string;
  ptoVta: number;
  cbteTipo: number;
}): string {
  return `arca-cbte:${key.environment}:${key.emisorCuit}:${key.ptoVta}:${key.cbteTipo}`;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toSummary(invoice: Invoice): InvoiceSummaryDto {
  return {
    id: invoice.id,
    arcaAccountId: invoice.arcaAccountId ?? null,
    emisorCuit: invoice.emisorCuit,
    emisorRazonSocial: invoice.emisorRazonSocial,
    selectedPaymentIds: invoice.selectedPaymentIds ?? [],
    status: invoice.status,
    cbteTipo: invoice.cbteTipo,
    ptoVta: invoice.ptoVta,
    cbteNro: invoice.cbteNro,
    cae: invoice.cae,
    caeVto: isoDate(invoice.caeVto),
    receptorNombre: invoice.receptorNombre,
    receptorDocTipo: invoice.receptorDocTipo,
    receptorDocNro: invoice.receptorDocNro,
    errorCode: invoice.errorCode,
    errorMessage: invoice.errorMessage,
  };
}

function toInvoiceDto(invoice: Invoice): InvoiceDto {
  return {
    ...toSummary(invoice),
    tenantId: invoice.tenantId,
    entryId: invoice.entryId,
    receptorDocTipo: invoice.receptorDocTipo,
    receptorDocNro: invoice.receptorDocNro,
    impTotal: Number(invoice.impTotal),
    impNeto: invoice.impNeto === null ? null : Number(invoice.impNeto),
    impIva: invoice.impIva === null ? null : Number(invoice.impIva),
    cbteFch: isoDate(invoice.cbteFch),
    issuedAt: invoice.issuedAt,
    version: invoice.version,
    syncSeq: invoice.syncSeq,
    updatedAt: invoice.updatedAt,
  };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
