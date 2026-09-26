import { Injectable } from '@nestjs/common';
import { InvoicePdfGenerator, type InvoiceData } from '@arcasdk/pdf';

/**
 * Pasa `InvoiceData` a PDF con la plantilla oficial de `@arcasdk/pdf`, que
 * abre un Chromium headless por PDF (en Cloud Run, el del sistema:
 * `PUPPETEER_EXECUTABLE_PATH`, ver el Dockerfile).
 *
 * De a uno por instancia: cada Chromium son ~200 MB, y dos o tres PDFs a la
 * vez en una instancia de 1 GiB la tumban. Se encolan; cada uno tarda 1-3 s.
 * Aparte del servicio para poder reemplazarlo en los tests.
 */
@Injectable()
export class InvoicePdfRenderer {
  private readonly generator = new InvoicePdfGenerator({ pageSize: 'A4' });
  private queue: Promise<unknown> = Promise.resolve();

  render(data: InvoiceData): Promise<Buffer> {
    const next = this.queue.then(() => this.generator.generate(data));
    this.queue = next.catch(() => undefined);
    return next;
  }
}
