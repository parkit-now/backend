import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PaymentTransactionChangesQueryDto } from './dto/payment-transaction-changes-query.dto';
import { PaymentTransactionDto } from './dto/payment-transaction.dto';

type PrismaPaymentTransaction = Prisma.PaymentTransactionGetPayload<
  Record<string, never>
>;

export function toPaymentTransactionDto(
  pt: PrismaPaymentTransaction,
): PaymentTransactionDto {
  return {
    id: pt.id,
    tenantId: pt.tenantId,
    entryId: pt.entryId,
    cashSessionId: pt.cashSessionId,
    paymentMethodId: pt.paymentMethodId,
    paymentMethodName: pt.paymentMethodName,
    amount: Number(pt.amount),
    version: pt.version,
    syncSeq: pt.syncSeq,
    updatedAt: pt.updatedAt,
  };
}

@Injectable()
export class PaymentTransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async pullChanges(
    query: PaymentTransactionChangesQueryDto,
  ): Promise<{ items: PaymentTransactionDto[]; maxSeq: number }> {
    const tenantPrisma = this.prisma.getTenantClient();
    const items = await tenantPrisma.paymentTransaction.findMany({
      where: { syncSeq: { gt: query.afterSeq } },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });
    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toPaymentTransactionDto), maxSeq };
  }
}
