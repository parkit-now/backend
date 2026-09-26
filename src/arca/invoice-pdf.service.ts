import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  buildInvoicePdfData,
  invoicePdfFileName,
  isPrintable,
} from './invoice-pdf';
import { InvoicePdfRenderer } from './invoice-pdf.renderer';

export interface InvoicePdf {
  readonly fileName: string;
  readonly content: Buffer;
}

/**
 * PDF de una factura emitida, a demanda y sin guardarlo: se arma cada vez
 * desde la fila de `invoices`, que tiene todo lo que se le mandó a ARCA y la
 * foto del emisor de ese día.
 */
@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: InvoicePdfRenderer,
  ) {}

  async render(invoiceId: string): Promise<InvoicePdf> {
    const db = this.prisma.getTenantClient();
    const invoice = await db.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Invoice ${invoiceId} not found in this entity.`,
        this.instance(invoiceId),
        ErrorCodes.NOT_FOUND,
      );
    }
    if (!isPrintable(invoice)) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Only issued invoices have a PDF.',
        this.instance(invoiceId),
        ErrorCodes.INVOICE_NOT_ISSUED,
      );
    }
    const entry = await db.entry.findFirstOrThrow({
      where: { id: invoice.entryId },
      select: { plate: true, enteredAt: true, leftAt: true },
    });

    try {
      const content = await this.renderer.render(
        buildInvoicePdfData(invoice, entry),
      );
      return { fileName: invoicePdfFileName(invoice, entry.plate), content };
    } catch (error) {
      this.logger.error(
        `No se pudo generar el PDF de la factura ${invoiceId}`,
        error instanceof Error ? error.stack : error,
      );
      throw new FormattedException(
        'Service Unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
        'The PDF could not be generated.',
        this.instance(invoiceId),
        ErrorCodes.INVOICE_PDF_FAILED,
      );
    }
  }

  private instance(invoiceId: string): string {
    return `/tenants/:tenantId/invoices/${invoiceId}/pdf`;
  }
}
