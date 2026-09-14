import type { MpAccount } from '@prisma/client';
import { MpAccountDto } from './dto/mp-account.dto';

/**
 * Mappers puros de la integración con Mercado Pago. Funciones exportadas fuera
 * de toda clase, modelo `src/entities/entities.mappers.ts`: no tienen estado,
 * no tocan la base y se testean sin levantar un módulo de Nest.
 */

/**
 * `MpAccount` (fila de Prisma) → `MpAccountDto` (contrato HTTP).
 *
 * 🔴 Los campos se listan UNO POR UNO, a mano, y esto NO es verbosidad al
 * pedo: es la garantía de que los tokens no se publican nunca.
 *
 * La alternativa tentadora es `{ ...account, accessToken: undefined }` o un
 * `omit`. Las dos fallan igual: el día que alguien agregue una columna al
 * modelo —un `webhookSecret`, un `posSecret`, lo que sea— el spread la publica
 * SOLA, en silencio, en el próximo `bun run db:generate`. Nadie lo revisa
 * porque el diff del PR no toca este archivo. Con la lista explícita, una
 * columna nueva simplemente no sale: hay que venir acá y decidirlo.
 *
 * Es exactamente la clase de bug que se cuela en un refactor, por eso hay un
 * test que afirma que el DTO no contiene ni `accessToken` ni `refreshToken` ni
 * `tokenKeyVersion`.
 */
export function toMpAccountDto(account: MpAccount): MpAccountDto {
  return {
    id: account.id,
    tenantId: account.tenantId,
    mpUserId: account.mpUserId,
    status: account.status,
    storeId: account.storeId,
    posId: account.posId,
    externalPosId: account.externalPosId,
    qrImageUrl: account.qrImageUrl,
    qrTemplateDocumentUrl: account.qrTemplateDocumentUrl,
    accessTokenExpiresAt: account.accessTokenExpiresAt.toISOString(),
    refreshFailureCount: account.refreshFailureCount,
    lastRefreshAt: account.lastRefreshAt?.toISOString() ?? null,
    linkedAt: account.linkedAt.toISOString(),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}
