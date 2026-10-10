import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  buildInvoiceDocument,
  isPrintable,
  type InvoiceDocument,
} from './invoice-document';

/**
 * Los datos del comprobante de una factura emitida, para que el desktop arme
 * el PDF. Se leen cada vez de la fila de `invoices`, que tiene todo lo que se
 * le mandó a ARCA y la foto del emisor de ese día.
 *
 * El backend no dibuja el PDF: hacerlo pedía un Chromium dentro de Cloud Run
 * (~300 MB de imagen, 1 GiB de memoria y 1-3 s por PDF), y el desktop ya
 * trae uno con Electron.
 */
@Injectable()
export class InvoiceDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  async get(invoiceId: string): Promise<InvoiceDocument> {
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
        'Only issued invoices have a document.',
        this.instance(invoiceId),
        ErrorCodes.INVOICE_NOT_ISSUED,
      );
    }
    const entry = await db.entry.findFirstOrThrow({
      where: { id: invoice.entryId },
      select: { plate: true, enteredAt: true, leftAt: true },
    });
    // Sólo para lo que la foto no tiene (ver `buildInvoiceDocument`).
    const account =
      (invoice.emisorIibb && invoice.emisorInicioActividad) ||
      (!invoice.arcaAccountId && !invoice.emisorCuit)
        ? null
        : await this.prisma.arcaAccount.findFirst({
            where: {
              tenantId: invoice.tenantId,
              ...(invoice.arcaAccountId
                ? { id: invoice.arcaAccountId }
                : {
                    cuit: invoice.emisorCuit ?? undefined,
                    ptoVta: invoice.ptoVta ?? undefined,
                    environment: invoice.environment ?? undefined,
                  }),
            },
            select: { iibb: true, inicioActividad: true },
          });

    return buildInvoiceDocument(invoice, entry, {
      iibb: account?.iibb ?? null,
      inicioActividad: account?.inicioActividad ?? null,
    });
  }

  private instance(invoiceId: string): string {
    return `/tenants/:tenantId/invoices/${invoiceId}/document`;
  }
}
