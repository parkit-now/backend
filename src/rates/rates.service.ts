import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Rate, type User } from '@prisma/client';
import { AuditActions } from '../audit/audit.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { CreateRateDto } from './dto/create-rate.dto';
import { ListRatesQueryDto } from './dto/list-rates-query.dto';
import { RateDto } from './dto/rate.dto';
import { RateChangesQueryDto } from './dto/rate-changes-query.dto';
import { UpdateRateDto } from './dto/update-rate.dto';
import {
  OpenEntriesByRateDto,
  OpenEntriesForRateDto,
} from './dto/open-entries-by-rate.dto';

type PrismaRate = Prisma.RateGetPayload<Record<string, never>>;

function toDto(rate: PrismaRate): RateDto {
  return {
    ...rate,
    hourPriceArs: Number(rate.hourPriceArs),
    stayPriceArs: Number(rate.stayPriceArs),
    fractionPriceArs: Number(rate.fractionPriceArs),
    mediaEstadiaPriceArs: Number(rate.mediaEstadiaPriceArs),
  };
}

type RateChangesResponse = {
  items: RateDto[];
  maxSeq: number;
};

/**
 * Cuántas estadías afectadas se listan en la auditoría.
 *
 * El conteo total va aparte y sin tope; esto acota el JSON en una playa
 * grande, con un flag `truncated` para que se note que la lista está cortada.
 */
const AUDIT_AFFECTED_CAP = 200;

/**
 * Si esta edición toca algún precio.
 *
 * Es lo que decide si la propagación tiene sentido. El nombre, el atajo y el
 * estado activo/inactivo no cambian lo que se cobra, así que una edición que
 * sólo toca eso NO propaga nada aunque venga el flag en true.
 *
 * `autoFractionPrice` a propósito no cuenta: es una preferencia del formulario
 * y el motor de cobro ni la lee. Pero prenderla reescribe `fractionPriceArs`,
 * y ese sí cuenta — el disparador es siempre el campo de precio.
 */
function hasPriceChange(data: UpdateRateDto): boolean {
  return (
    data.hourPriceArs !== undefined ||
    data.fractionPriceArs !== undefined ||
    data.mediaEstadiaPriceArs !== undefined ||
    data.stayPriceArs !== undefined
  );
}

@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createRate(data: CreateRateDto): Promise<RateDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const rate = await tenantPrisma.rate.create({
      data: {
        id: data.id,
        name: data.name,
        hourPriceArs: data.hourPriceArs,
        stayPriceArs: data.stayPriceArs,
        fractionPriceArs: data.fractionPriceArs,
        mediaEstadiaPriceArs: data.mediaEstadiaPriceArs,
        autoFractionPrice: data.autoFractionPrice ?? false,
        shortcutNumber: data.shortcutNumber ?? null,
        // tenantId is injected by prismaForTenant(...)
      } as Prisma.RateUncheckedCreateInput,
    });
    return toDto(rate);
  }

  async listRates(query: ListRatesQueryDto): Promise<RateDto[]> {
    const tenantPrisma = this.prisma.getTenantClient();
    // Soft-deleted rates are never listed. This is independent of
    // `includeInactive`: `isActive: false` means "deactivated" (still visible
    // and reactivable in the owner panel), `deletedAt` means "deleted".
    const where: Prisma.RateWhereInput = { deletedAt: null };

    if (!query.includeInactive) {
      where.isActive = true;
    }

    const rates = await tenantPrisma.rate.findMany({
      where,
      orderBy: [{ name: 'asc' }],
    });
    return rates.map(toDto);
  }

  /**
   * Incremental sync feed. Deliberately does NOT filter `deletedAt`: shipping
   * soft-deleted rows with a non-null `deletedAt` is precisely how a deletion
   * reaches offline clients. Mirrors `VehiclesService.pullCatalogChanges`.
   */
  async pullChanges(query: RateChangesQueryDto): Promise<RateChangesResponse> {
    const tenantPrisma = this.prisma.getTenantClient();

    const items = await tenantPrisma.rate.findMany({
      where: {
        syncSeq: { gt: query.afterSeq },
      },
      orderBy: [{ syncSeq: 'asc' }],
      take: query.limit,
    });

    const maxSeq =
      items.length > 0 ? items[items.length - 1].syncSeq : query.afterSeq;
    return { items: items.map(toDto), maxSeq };
  }

  /**
   * Cuántos autos hay adentro con cada tarifa.
   *
   * Lo consume la web para decidir si preguntar al guardar un cambio de
   * precios. Usa el índice `entries_tenant_left_at_idx`.
   */
  async countOpenEntriesByRate(): Promise<OpenEntriesByRateDto> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const groups = await tenantPrisma.entry.groupBy({
      by: ['rateId'],
      where: { tenantId, leftAt: null },
      _count: { _all: true },
    });

    const counts: OpenEntriesForRateDto[] = [];
    let withoutRate = 0;
    for (const group of groups) {
      if (group.rateId === null) {
        withoutRate = group._count._all;
        continue;
      }
      counts.push({ rateId: group.rateId, openEntries: group._count._all });
    }

    return { counts, withoutRate };
  }

  async updateRate(
    rateId: string,
    expectedVersion: number,
    data: UpdateRateDto,
    user?: User,
  ) {
    // Sin `getTenantClient()`: todo corre dentro de `$transaction`, que entrega
    // un cliente crudo. Por eso cada `where` de acá abajo lleva `tenantId`.
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const updateData: Prisma.RateUpdateManyMutationInput = {
      version: { increment: 1 },
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.hourPriceArs !== undefined)
      updateData.hourPriceArs = data.hourPriceArs;
    if (data.stayPriceArs !== undefined)
      updateData.stayPriceArs = data.stayPriceArs;
    if (data.fractionPriceArs !== undefined)
      updateData.fractionPriceArs = data.fractionPriceArs;
    if (data.mediaEstadiaPriceArs !== undefined)
      updateData.mediaEstadiaPriceArs = data.mediaEstadiaPriceArs;
    if (data.autoFractionPrice !== undefined)
      updateData.autoFractionPrice = data.autoFractionPrice;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.shortcutNumber !== undefined)
      updateData.shortcutNumber = data.shortcutNumber;

    return this.prisma.$transaction(async (tx) => {
      // `$transaction` entrega un cliente CRUDO, sin la extensión de tenant, así
      // que cada `where` lleva `tenantId` explícito. No es decorativo: sin eso
      // se tocarían filas de otro estacionamiento.
      const before =
        data.applyToOpenEntries === true
          ? await tx.rate.findFirst({ where: { tenantId, id: rateId } })
          : null;

      const result = await tx.rate.updateMany({
        where: {
          tenantId,
          id: rateId,
          version: expectedVersion,
          deletedAt: null,
        },
        data: updateData,
      });

      // El chequeo de versión va PRIMERO: así una edición que llega con una
      // versión vieja no propaga nada a las estadías.
      if (result.count === 0) {
        throw new FormattedException(
          'Conflict',
          HttpStatus.CONFLICT,
          'Rate was changed by another write. Refresh and retry with the latest version.',
          `/tenants/:tenantId/rates/${rateId}`,
          ErrorCodes.CONFLICT,
        );
      }

      const updated = await tx.rate.findUniqueOrThrow({
        where: { id: rateId },
      });

      if (data.applyToOpenEntries === true && hasPriceChange(data)) {
        await this.propagatePricesToOpenEntries({
          tx,
          tenantId,
          rate: updated,
          before,
          actorUserId: user?.id ?? null,
        });
      }

      return toDto(updated);
    });
  }

  /**
   * Reescribe el snapshot de precios de las estadías ABIERTAS con esta tarifa.
   *
   * ESTO ROMPE, A PEDIDO, LA INMUTABILIDAD DEL SNAPSHOT
   *
   * El snapshot se congela al entrar justamente para que una edición de tarifa
   * no le cambie el precio a un auto que ya está adentro. Sigue siendo así por
   * defecto: esto corre SÓLO si el dueño contestó que sí a una pregunta
   * explícita. Las estadías ya cerradas no se tocan nunca.
   *
   * SE ESCRIBEN LOS CUATRO PRECIOS, aunque haya cambiado uno solo, y salen de
   * la fila ya actualizada y no del DTO parcial. Es lo que cumple lo que
   * promete el diálogo —"quedan con la tarifa tal como está ahora"— y evita
   * dejar en un estado mixto a una estadía cuyo snapshot ya hubiera divergido,
   * por ejemplo porque alguien la corrigió a mano.
   *
   * `rateSnapshotName` NO se toca: la pregunta es sobre precios. Renombrar una
   * tarifa no pregunta nada, así que propagar el nombre acá sería una regla
   * inconsistente y una sorpresa en el ticket.
   *
   * NO SE INCREMENTA `version`, Y ES DELIBERADO
   *
   * `version` en `entries` es el token de concurrencia del EGRESO. Si este lote
   * lo incrementara, todo cobro que llegue con la versión cacheada rebotaría
   * con 409 — y un 409 en el egreso es un auto trabado en la barrera porque el
   * dueño tocó un precio desde la web. No hay lost-update que proteger: los
   * conjuntos de columnas son disjuntos, `CloseEntryDto` no tiene ningún campo
   * de snapshot. El trigger bumpea `sync_seq` igual, así que la propagación
   * viaja por `/entries/changes` sin invalidarle la versión a nadie.
   */
  private async propagatePricesToOpenEntries(input: {
    tx: Prisma.TransactionClient;
    tenantId: string;
    rate: Rate;
    before: Rate | null;
    actorUserId: string | null;
  }): Promise<void> {
    const { tx, tenantId, rate } = input;

    // `findMany` + `updateMany` por ids, y no un `updateMany` directo por
    // `rateId`: así el conjunto que se audita es EXACTAMENTE el que se escribió.
    const targets = await tx.entry.findMany({
      where: { tenantId, rateId: rate.id, leftAt: null },
      select: { id: true, plate: true, ticketNumber: true },
    });

    if (targets.length === 0) return;

    await tx.entry.updateMany({
      where: { tenantId, id: { in: targets.map((t) => t.id) } },
      data: {
        rateSnapshotHourPriceArs: rate.hourPriceArs,
        rateSnapshotFractionPriceArs: rate.fractionPriceArs,
        rateSnapshotMediaEstadiaPriceArs: rate.mediaEstadiaPriceArs,
        rateSnapshotStayPriceArs: rate.stayPriceArs,
      },
    });

    await tx.auditLog.create({
      data: {
        action: AuditActions.RATE_PRICES_PROPAGATED,
        entityType: 'rate',
        entityId: rate.id,
        actorUserId: input.actorUserId,
        tenantId,
        // `warn`: cambia lo que se le va a cobrar a autos que ya están
        // adentro. Es lo primero que hay que poder encontrar cuando un
        // conductor discute un ticket.
        severity: 'warn',
        metadata: {
          rateName: rate.name,
          before: input.before && {
            hour: input.before.hourPriceArs.toString(),
            fraction: input.before.fractionPriceArs.toString(),
            mediaEstadia: input.before.mediaEstadiaPriceArs.toString(),
            stay: input.before.stayPriceArs.toString(),
          },
          after: {
            hour: rate.hourPriceArs.toString(),
            fraction: rate.fractionPriceArs.toString(),
            mediaEstadia: rate.mediaEstadiaPriceArs.toString(),
            stay: rate.stayPriceArs.toString(),
          },
          affectedCount: targets.length,
          // El cap evita un JSON gigante en una playa de 500 cocheras.
          affected: targets.slice(0, AUDIT_AFFECTED_CAP),
          truncated: targets.length > AUDIT_AFFECTED_CAP,
        },
      },
    });
  }

  /**
   * Soft delete: stamps `deletedAt` instead of removing the row.
   *
   * The `rates_before_update` trigger bumps `sync_seq` on any UPDATE, so the
   * marked row keeps flowing through `pullChanges` as a tombstone and offline
   * clients can drop it locally. A hard delete emits nothing, which is why a
   * deleted rate used to linger forever in the desktop's IndexedDB.
   *
   * `deletedAt: null` in the where clause makes a second DELETE return 409
   * instead of re-stamping the mark and re-emitting the tombstone.
   */
  async deleteRate(rateId: string, expectedVersion: number): Promise<void> {
    const tenantPrisma = this.prisma.getTenantClient();
    const tenantId = this.tenantContext.getTenantIdOrThrow();

    const result = await tenantPrisma.rate.updateMany({
      where: {
        tenantId,
        id: rateId,
        version: expectedVersion,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        'Rate was changed by another write. Refresh and retry with the latest version.',
        `/tenants/:tenantId/rates/${rateId}`,
        ErrorCodes.CONFLICT,
      );
    }
  }
}
