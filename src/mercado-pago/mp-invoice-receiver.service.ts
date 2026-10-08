import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type PaymentIntent } from '@prisma/client';
import { isValidCuit } from '../arca/arca-cuit';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { ErrorCodes, type ErrorCode } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { MpApiClient } from './mp-api.client';
import { MpTokenService } from './mp-token.service';
import type { InvoiceReceiverSuggestionDto } from './dto/invoice-receiver-suggestion.dto';

const INSTANCE =
  '/tenants/:tenantId/entries/:entryId/invoice/receiver-suggestion';

@Injectable()
export class MpInvoiceReceiverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
    private readonly mp: MpApiClient,
    private readonly tokens: MpTokenService,
  ) {}

  async suggest(
    entryId: string,
    paymentIntentId?: string,
  ): Promise<InvoiceReceiverSuggestionDto> {
    const tenantId = this.context.getTenantIdOrThrow();
    const entry = await this.prisma.getTenantClient().entry.findFirst({
      where: { id: entryId, deletedAt: null },
      select: { id: true },
    });
    if (!entry) throw this.notFound(ErrorCodes.NOT_FOUND);
    const intents = await this.eligibleIntents(
      tenantId,
      entryId,
      paymentIntentId,
    );
    if (paymentIntentId && intents.length === 0) {
      throw this.notFound(ErrorCodes.PAYMENT_INTENT_NOT_FOUND);
    }
    if (intents.length === 0) return { cuit: null };

    // No transaction remains open during token refresh or provider requests.
    const cuits = await Promise.all(
      intents.map((intent) => this.resolve(intent)),
    );
    // Recheck associations: a correction may have replaced the payment meanwhile.
    const current = await this.eligibleIntents(
      tenantId,
      entryId,
      paymentIntentId,
    );
    if (
      current.length !== intents.length ||
      current.some(
        (intent) =>
          !intents.some(
            (previous) =>
              previous.id === intent.id &&
              previous.paymentTransactionId === intent.paymentTransactionId,
          ),
      )
    ) {
      return { cuit: null };
    }
    const unique = new Set(cuits);
    return { cuit: unique.size === 1 && !unique.has(null) ? cuits[0] : null };
  }

  private async eligibleIntents(
    tenantId: string,
    entryId: string,
    paymentIntentId?: string,
  ): Promise<PaymentIntent[]> {
    if (paymentIntentId) {
      return this.prisma.paymentIntent.findMany({
        where: { id: paymentIntentId, tenantId, entryId, status: 'approved' },
      });
    }
    const payments = await this.prisma
      .getTenantClient()
      .paymentTransaction.findMany({
        where: {
          entryId,
          deletedAt: null,
          paymentMethodType: 'mercadopago_qr',
        },
        select: { id: true },
      });
    return this.prisma.paymentIntent.findMany({
      where: {
        tenantId,
        entryId,
        status: 'consumed',
        paymentTransactionId: { in: payments.map((payment) => payment.id) },
      },
    });
  }

  private async resolve(intent: PaymentIntent): Promise<string | null> {
    if (
      intent.mpPaymentReferenceId &&
      intent.payerCuit &&
      !/^0+$/.test(intent.payerCuit) &&
      isValidCuit(intent.payerCuit)
    ) {
      return intent.payerCuit;
    }
    if (!intent.mpOrderId) return null;
    const { account, accessToken } = await this.tokens.getUsableAccessToken(
      intent.tenantId,
    );
    const order = await this.mp.getOrder(accessToken, intent.mpOrderId);
    if (
      order.id !== intent.mpOrderId ||
      order.status !== 'processed' ||
      order.externalReference !== intent.id
    )
      return null;
    const references = [
      ...new Set(
        (order.payments ?? [])
          .filter((payment) => payment.status === 'processed')
          .map((payment) => payment.referenceId),
      ),
    ];
    // One QR charge maps to one payment. Never pick an arbitrary payer.
    if (
      references.length !== 1 ||
      !references[0] ||
      !/^\d+$/.test(references[0])
    )
      return null;
    const reference = references[0];
    const payment = await this.mp.getPayment(accessToken, reference);
    if (
      payment.id !== reference ||
      payment.status !== 'approved' ||
      payment.collectorId !== account.mpUserId ||
      payment.externalReference !== intent.id ||
      payment.transactionAmount === null ||
      !new Prisma.Decimal(payment.transactionAmount)
        .mul(100)
        .equals(intent.amount.mul(100)) ||
      (payment.transactionAmountRefunded ?? 0) !== 0
    )
      return null;
    const identification = payment.payerIdentification;
    if (
      identification?.type !== 'CUIT' ||
      !identification.number ||
      /^0+$/.test(identification.number) ||
      !isValidCuit(identification.number)
    )
      return null;
    const result = await this.prisma.paymentIntent.updateMany({
      where: {
        id: intent.id,
        tenantId: intent.tenantId,
        entryId: intent.entryId,
        status: intent.status,
        mpOrderId: intent.mpOrderId,
        amount: intent.amount,
      },
      data: {
        mpPaymentReferenceId: reference,
        payerCuit: identification.number,
      },
    });
    return result.count === 1 ? identification.number : null;
  }

  private notFound(code: ErrorCode): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      'Entry or approved payment intent not found',
      INSTANCE,
      code,
    );
  }
}
