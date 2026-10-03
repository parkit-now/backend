/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
// Prisma en memoria para las specs del módulo de reservas: lo justo para
// ejecutar de verdad las transiciones, el alta y las lecturas.
export type Row = Record<string, any>;

function matches(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Date)
    ) {
      if ('in' in expected) return expected.in.includes(actual);
      if ('lt' in expected) return actual !== null && actual < expected.lt;
      if ('not' in expected) return actual !== expected.not;
      return false;
    }
    return actual === expected;
  });
}

/** Prisma en memoria: lo justo para ejecutar las transiciones de verdad. */
export class FakePrisma {
  reservations: Row[] = [];
  payments: Row[] = [];
  reservableSpots: number | null = 1;
  /** Lo que devuelve la consulta de cupo (reservas que se superponen). */
  overlapping: { entryAt: Date; exitAt: Date }[] = [];
  capacityQueries: any[] = [];
  /** Playa que devuelve el `include: { tenant }`. */
  tenant: Row = {
    name: 'Estacionamiento Once',
    address: 'BARTOLOME MITRE 2500',
    latitude: null,
    longitude: null,
  };
  readonly $executeRaw = jest.fn();

  reservation = {
    findFirst: async ({ where }: any) =>
      this.copy(this.reservations.find((r) => matches(r, where))),
    findMany: async (args: any) => {
      this.capacityQueries.push(args);
      return this.overlapping;
    },
    updateMany: async ({ where, data }: any) => {
      const hit = this.reservations.filter((r) => matches(r, where));
      hit.forEach((r) => this.apply(r, data));
      return { count: hit.length };
    },
    findUnique: async ({ where }: any) => {
      const row = this.reservations.find((r) => r.id === where.id);
      return row ? this.withIncludes(row) : null;
    },
    create: async ({ data }: any) => {
      const row: Row = {
        paidAt: null,
        approvalDeadlineAt: null,
        cancelledAt: null,
        cancelledBy: null,
        reason: null,
        refundStatus: 'none',
        refundedAmountArs: null,
        refundError: null,
        refundRequestedAt: null,
        refundRequestedArs: null,
        refundAttempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.reservations.push(row);
      return this.withIncludes(row);
    },
    update: async ({ where, data }: any) => {
      const row = this.reservations.find((r) => r.id === where.id)!;
      this.apply(row, data);
      return { ...row };
    },
  };

  reservationPayment = {
    create: async ({ data }: any) => {
      const row: Row = {
        id: `pay-${this.payments.length + 1}`,
        providerPaymentId: null,
        createdAt: new Date(Date.now() + this.payments.length),
        ...data,
      };
      this.payments.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: any) =>
      this.copy(
        [...this.payments]
          .reverse()
          .find((p) => matches(p, stripNot(where, p))),
      ),
    updateMany: async ({ where, data }: any) => {
      const hit = this.payments.filter((p) => matches(p, where));
      hit.forEach((p) => this.apply(p, data));
      return { count: hit.length };
    },
  };

  service = {
    findFirst: async () =>
      this.reservableSpots === null
        ? null
        : { reservableSpots: this.reservableSpots },
  };

  $transaction = async (fn: (tx: this) => unknown) => fn(this);

  /** Lo que el servicio del conductor pide con `include` (tenant + último pago). */
  private withIncludes(row: Row): Row {
    const payments = this.payments
      .filter((p) => p.reservationId === row.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { ...row, tenant: this.tenant, payments: payments.slice(0, 1) };
  }

  private copy(row: Row | undefined) {
    return row ? { ...row } : null;
  }

  private apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value && typeof value === 'object' && 'increment' in value) {
        row[key] += value.increment;
      } else {
        row[key] = value;
      }
    }
  }

  /** Id que usan por defecto `reservationById` y `paymentOf`. */
  defaultId = '0192f0a0-0000-7000-8000-00000000abcd';

  reservationById(id = this.defaultId): Row {
    return this.reservations.find((r) => r.id === id)!;
  }

  paymentOf(reservationId = this.defaultId): Row {
    return this.payments.find((p) => p.reservationId === reservationId)!;
  }
}

// `providerPaymentId: { not: null }` (el reembolso busca un pago con id).
export function stripNot(where: Row, row: Row): Row {
  const copy = { ...where };
  const value = copy.providerPaymentId;
  if (value && typeof value === 'object' && 'not' in value) {
    delete copy.providerPaymentId;
    if (row.providerPaymentId === value.not)
      copy.providerPaymentId = '__never__';
  }
  return copy;
}
