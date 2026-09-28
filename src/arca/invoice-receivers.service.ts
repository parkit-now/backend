import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { parseTaxpayer } from './arca-padron';
import {
  condicionIvaReceptorFor,
  type PadronReceiver,
} from './invoice-receiver';

/** Un CUIT que el padrón conoce se reusa 30 días. */
export const PADRON_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Uno que ARCA no tiene, sólo 1 día: puede inscribirse. */
export const PADRON_MISS_TTL_MS = 24 * 60 * 60_000;

export const RECEIVER_SUGGESTIONS_MAX = 20;

export interface InvoiceReceiverSuggestion {
  readonly cuit: string;
  readonly razonSocial: string | null;
  readonly condicionIvaReceptorId: number | null;
  readonly lastUsedAt: Date;
}

/**
 * Receptores con CUIT de cada playa (`invoice_receivers`): caché del padrón de
 * ARCA y sugerencias del cobro.
 *
 * La tabla es global (sin `TENANT_MODELS`): cada consulta filtra a mano por el
 * `tenantId`. No sabe hablar con ARCA: quien la usa le pasa cómo consultar el
 * padrón, así la llamada queda auditada donde corresponde.
 */
@Injectable()
export class InvoiceReceiversService {
  private readonly logger = new Logger(InvoiceReceiversService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lo que dice el padrón del CUIT: de la caché si está fresca, si no de ARCA
   * (y se guarda). Tira lo mismo que `fetchTaxpayer` si ARCA falla.
   */
  async lookup(
    tenantId: string,
    cuit: string,
    fetchTaxpayer: () => Promise<unknown>,
  ): Promise<PadronReceiver> {
    const cached = await this.prisma.invoiceReceiver.findUnique({
      where: { tenantId_cuit: { tenantId, cuit } },
      select: {
        razonSocial: true,
        condicionIvaReceptorId: true,
        fetchedAt: true,
      },
    });
    if (cached && isFresh(cached, Date.now())) {
      return {
        razonSocial: cached.razonSocial,
        condicionIvaReceptorId: cached.condicionIvaReceptorId,
      };
    }

    const fiscal = parseTaxpayer(await fetchTaxpayer());
    const padron: PadronReceiver = fiscal
      ? {
          razonSocial: fiscal.razonSocial,
          condicionIvaReceptorId: condicionIvaReceptorFor(fiscal.condicionIva),
        }
      : { razonSocial: null, condicionIvaReceptorId: null };
    const fetchedAt = new Date();
    await this.prisma.invoiceReceiver.upsert({
      where: { tenantId_cuit: { tenantId, cuit } },
      create: { tenantId, cuit, ...padron, fetchedAt },
      update: { ...padron, fetchedAt },
    });
    return padron;
  }

  /**
   * Marca el CUIT como facturado, para sugerirlo. Nunca tira: una sugerencia
   * que falta no puede romper una factura ya emitida.
   */
  async markUsed(tenantId: string, cuit: string): Promise<void> {
    const now = new Date();
    await this.prisma.invoiceReceiver
      .upsert({
        where: { tenantId_cuit: { tenantId, cuit } },
        // Sin fila (se emitió sin pasar por la caché): `fetchedAt` viejo para
        // que la próxima consulta vaya a ARCA.
        create: { tenantId, cuit, fetchedAt: new Date(0), lastUsedAt: now },
        update: { lastUsedAt: now },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `No se pudo marcar el receptor ${cuit} como usado: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }

  /**
   * CUIT ya facturados, del más reciente al más viejo. `q` con dígitos busca
   * por el principio del CUIT; con letras, dentro de la razón social.
   */
  async suggestions(
    tenantId: string,
    q: string | undefined,
    limit: number,
  ): Promise<InvoiceReceiverSuggestion[]> {
    const text = q?.trim() ?? '';
    const digits = text.replace(/[\s-]/g, '');
    const filter = !text
      ? {}
      : /^\d+$/.test(digits)
        ? { cuit: { startsWith: digits } }
        : { razonSocial: { contains: text, mode: 'insensitive' as const } };

    const rows = await this.prisma.invoiceReceiver.findMany({
      where: { tenantId, lastUsedAt: { not: null }, ...filter },
      orderBy: { lastUsedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), RECEIVER_SUGGESTIONS_MAX),
      select: {
        cuit: true,
        razonSocial: true,
        condicionIvaReceptorId: true,
        lastUsedAt: true,
      },
    });
    return rows.map((row) => ({ ...row, lastUsedAt: row.lastUsedAt! }));
  }
}

function isFresh(
  row: { condicionIvaReceptorId: number | null; fetchedAt: Date },
  now: number,
): boolean {
  const ttl =
    row.condicionIvaReceptorId === null
      ? PADRON_MISS_TTL_MS
      : PADRON_CACHE_TTL_MS;
  return now - row.fetchedAt.getTime() < ttl;
}
