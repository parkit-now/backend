import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole, Prisma, Tenant, User } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { TenantStaffService } from './tenant-staff.service';

const ONCE = '0198f2a4-0000-7000-8000-00000000000a';
const BELGRANO = '0198f2a4-0000-7000-8000-00000000000b';
const FOREIGN = '0198f2a4-0000-7000-8000-00000000000f';

const CALLER = '0198f2a4-0000-7000-8000-000000000001';
const ANA = '0198f2a4-0000-7000-8000-000000000002';

const owner = { id: CALLER, role: 'user', email: 'due@x.com' } as User;
const admin = { id: CALLER, role: 'admin', email: 'root@x.com' } as User;

function person(overrides: Partial<User> = {}): User {
  return {
    id: ANA,
    role: 'user',
    email: 'ana@example.com',
    name: 'Ana Gómez',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function tenant(id: string, name = 'Estacionamiento Once'): Tenant {
  return { id, name } as Tenant;
}

function membership(
  tenantId: string,
  role: MembershipRole,
  userId = ANA,
  createdAt = new Date('2026-02-01T00:00:00Z'),
) {
  return {
    userId,
    tenantId,
    role,
    createdAt,
    tenant: tenant(tenantId),
    user: person(),
  };
}

describe('TenantStaffService', () => {
  let service: TenantStaffService;

  // El cliente transaccional es un mock propio: los tests asertan que las
  // escrituras van contra `tx` y no contra el cliente de afuera.
  const tx = {
    userMembership: {
      count: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };

  const prisma = {
    user: { findFirst: jest.fn() },
    tenant: { findUnique: jest.fn() },
    userMembership: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const audit = { record: jest.fn() };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TenantStaffService,
        { provide: PrismaService, useValue: prisma },
        // `PermissionsService` va real: es puro y sin DB, mockearlo sería
        // mockear justamente la regla bajo prueba.
        PermissionsService,
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(TenantStaffService);
    jest.clearAllMocks();

    prisma.$transaction.mockImplementation(
      (cb: (client: typeof tx) => unknown) => cb(tx),
    );
    tx.userMembership.count.mockResolvedValue(2);
  });

  /** El error que tiró la promesa, para poder asertar status y code. */
  async function failure(
    promise: Promise<unknown>,
  ): Promise<FormattedException> {
    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FormattedException);
    return error as FormattedException;
  }

  function expectProblem(
    error: FormattedException,
    status: HttpStatus,
    code: string,
  ): void {
    expect(error.getStatus()).toBe(status);
    expect((error.getResponse() as { code: string }).code).toBe(code);
  }

  /** Los `data` de cada fila de auditoría escrita dentro de la transacción. */
  function auditRows(): Record<string, unknown>[] {
    return tx.auditLog.create.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
  }

  // ---------------------------------------------------------------- addStaff

  describe('addStaff', () => {
    beforeEach(() => {
      prisma.user.findFirst.mockResolvedValue(person());
      prisma.userMembership.findUnique.mockResolvedValue(null);
      prisma.userMembership.create.mockResolvedValue(
        membership(ONCE, MembershipRole.operator),
      );
    });

    it('links the person to the lot with the requested role', async () => {
      const result = await service.addStaff(owner, ONCE, {
        email: 'ana@example.com',
        role: MembershipRole.operator,
      });

      expect(prisma.userMembership.create).toHaveBeenCalledWith({
        data: { userId: ANA, tenantId: ONCE, role: MembershipRole.operator },
        include: { tenant: true },
      });
      expect(result).toMatchObject({
        userId: ANA,
        email: 'ana@example.com',
        tenantId: ONCE,
        role: MembershipRole.operator,
      });
    });

    it('normalizes the email before looking it up', async () => {
      await service.addStaff(owner, ONCE, {
        email: '  ANA@Example.COM ',
        role: MembershipRole.operator,
      });

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'ana@example.com', mode: 'insensitive' } },
        }),
      );
    });

    // Un mail guardado con mayúsculas en `public.users` haría imposible el alta
    // si la búsqueda fuese case-sensitive.
    it('matches the account case-insensitively', async () => {
      await service.addStaff(owner, ONCE, {
        email: 'ana@example.com',
        role: MembershipRole.operator,
      });

      const args = prisma.user.findFirst.mock.calls[0]?.[0] as {
        where: { email: { mode: string } };
      };
      expect(args.where.email.mode).toBe('insensitive');
    });

    it('404s without writing when no account has that email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const error = await failure(
        service.addStaff(owner, ONCE, {
          email: 'nadie@example.com',
          role: MembershipRole.operator,
        }),
      );

      expectProblem(error, HttpStatus.NOT_FOUND, ErrorCodes.USER_NOT_FOUND);
      expect(prisma.userMembership.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s when the person already works at the lot', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.operator),
      );

      const error = await failure(
        service.addStaff(owner, ONCE, {
          email: 'ana@example.com',
          role: MembershipRole.operator,
        }),
      );

      expectProblem(
        error,
        HttpStatus.CONFLICT,
        ErrorCodes.MEMBERSHIP_ALREADY_EXISTS,
      );
      expect(prisma.userMembership.create).not.toHaveBeenCalled();
    });

    // Dos owners dando de alta a la misma persona a la vez: el pre-chequeo pasa
    // en los dos y la PK compuesta frena al segundo.
    it('maps a P2002 race to the same 409', async () => {
      prisma.userMembership.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const error = await failure(
        service.addStaff(owner, ONCE, {
          email: 'ana@example.com',
          role: MembershipRole.operator,
        }),
      );

      expectProblem(
        error,
        HttpStatus.CONFLICT,
        ErrorCodes.MEMBERSHIP_ALREADY_EXISTS,
      );
    });

    it('rethrows unexpected prisma errors untouched', async () => {
      const boom = new Error('connection lost');
      prisma.userMembership.create.mockRejectedValue(boom);

      const thrown = await service
        .addStaff(owner, ONCE, {
          email: 'ana@example.com',
          role: MembershipRole.operator,
        })
        .catch((error: unknown) => error);

      expect(thrown).toBe(boom);
    });

    it('allows naming another owner (escape hatch)', async () => {
      prisma.userMembership.create.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );

      const result = await service.addStaff(owner, ONCE, {
        email: 'ana@example.com',
        role: MembershipRole.owner,
      });

      expect(result.role).toBe(MembershipRole.owner);
    });

    // Rechazarlo convertiría el endpoint en un oráculo para enumerar admins.
    it('accepts a target whose global role is admin', async () => {
      prisma.user.findFirst.mockResolvedValue(person({ role: 'admin' }));

      const result = await service.addStaff(owner, ONCE, {
        email: 'ana@example.com',
        role: MembershipRole.operator,
      });

      expect(result.globalRole).toBe('admin');
    });

    it('audits the creation against the lot and the actor', async () => {
      await service.addStaff(owner, ONCE, {
        email: 'ana@example.com',
        role: MembershipRole.operator,
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditActions.MEMBERSHIP_CREATED,
          entityType: 'user_membership',
          entityId: ANA,
          actorUserId: CALLER,
          tenantId: ONCE,
        }),
      );
    });
  });

  // ------------------------------------------------------- updateStaff: self

  describe('updateStaff · self-guard', () => {
    it('403s before touching the database', async () => {
      const error = await failure(
        service.updateStaff(owner, ONCE, CALLER, {
          role: MembershipRole.operator,
        }),
      );

      expectProblem(
        error,
        HttpStatus.FORBIDDEN,
        ErrorCodes.STAFF_SELF_MANAGEMENT,
      );
      expect(prisma.userMembership.findUnique).not.toHaveBeenCalled();
    });

    // Una sola regla, sin excepción para el admin global: si quiere, tiene
    // `/admin/users/:id/memberships`.
    it('applies to the global admin too', async () => {
      const error = await failure(
        service.updateStaff(admin, ONCE, CALLER, {
          role: MembershipRole.operator,
        }),
      );

      expectProblem(
        error,
        HttpStatus.FORBIDDEN,
        ErrorCodes.STAFF_SELF_MANAGEMENT,
      );
    });
  });

  // ------------------------------------------------------- updateStaff: role

  describe('updateStaff · role change', () => {
    beforeEach(() => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.operator),
      );
      tx.userMembership.update.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );
    });

    it('promotes an operator to owner', async () => {
      const result = await service.updateStaff(owner, ONCE, ANA, {
        role: MembershipRole.owner,
      });

      expect(tx.userMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_tenantId: { userId: ANA, tenantId: ONCE } },
          data: { role: MembershipRole.owner },
        }),
      );
      expect(result.role).toBe(MembershipRole.owner);
    });

    it('does not count owners when the target is an operator', async () => {
      await service.updateStaff(owner, ONCE, ANA, {
        role: MembershipRole.owner,
      });

      expect(tx.userMembership.count).not.toHaveBeenCalled();
    });

    it('demotes an owner while another one remains', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );
      tx.userMembership.update.mockResolvedValue(
        membership(ONCE, MembershipRole.operator),
      );
      tx.userMembership.count.mockResolvedValue(2);

      const result = await service.updateStaff(owner, ONCE, ANA, {
        role: MembershipRole.operator,
      });

      expect(result.role).toBe(MembershipRole.operator);
    });

    it('409s when demoting the last owner, without writing', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );
      tx.userMembership.count.mockResolvedValue(1);

      const error = await failure(
        service.updateStaff(owner, ONCE, ANA, {
          role: MembershipRole.operator,
        }),
      );

      expectProblem(error, HttpStatus.CONFLICT, ErrorCodes.STAFF_LAST_OWNER);
      expect(tx.userMembership.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s when the person does not work at the lot', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(null);

      const error = await failure(
        service.updateStaff(owner, ONCE, ANA, {
          role: MembershipRole.operator,
        }),
      );

      expectProblem(
        error,
        HttpStatus.NOT_FOUND,
        ErrorCodes.MEMBERSHIP_NOT_FOUND,
      );
    });

    it('is a no-op when the role sent is the current one', async () => {
      const result = await service.updateStaff(owner, ONCE, ANA, {
        role: MembershipRole.operator,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(result.role).toBe(MembershipRole.operator);
    });

    it('audits the update with the previous role', async () => {
      await service.updateStaff(owner, ONCE, ANA, {
        role: MembershipRole.owner,
      });

      const [row] = auditRows();
      expect(row.action).toBe(AuditActions.MEMBERSHIP_UPDATED);
      expect(row.tenantId).toBe(ONCE);
      expect(row.metadata).toEqual({
        role: MembershipRole.owner,
        previousRole: MembershipRole.operator,
      });
    });
  });

  // ------------------------------------------------------- updateStaff: move

  describe('updateStaff · move', () => {
    beforeEach(() => {
      // 1ª llamada: la membresía de Ana en el origen.
      // 2ª: la del caller en el destino (ownership).
      // 3ª: si Ana ya está en el destino.
      prisma.userMembership.findUnique
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(
          membership(BELGRANO, MembershipRole.owner, CALLER),
        )
        .mockResolvedValueOnce(null);
      prisma.tenant.findUnique.mockResolvedValue({ id: BELGRANO });
      tx.userMembership.update.mockResolvedValue(
        membership(BELGRANO, MembershipRole.operator),
      );
    });

    it('moves the membership keeping the current role', async () => {
      const result = await service.updateStaff(owner, ONCE, ANA, {
        tenantId: BELGRANO,
      });

      expect(tx.userMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_tenantId: { userId: ANA, tenantId: ONCE } },
          data: { tenantId: BELGRANO },
        }),
      );
      expect(result.tenantId).toBe(BELGRANO);
    });

    it('moves and changes the role in one call', async () => {
      await service.updateStaff(owner, ONCE, ANA, {
        tenantId: BELGRANO,
        role: MembershipRole.owner,
      });

      expect(tx.userMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { tenantId: BELGRANO, role: MembershipRole.owner },
        }),
      );
    });

    // Un `delete` + `create` perdería `createdAt`, o sea la antigüedad de la
    // persona en la empresa.
    it('uses a single update, never delete + create', async () => {
      await service.updateStaff(owner, ONCE, ANA, { tenantId: BELGRANO });

      expect(tx.userMembership.update).toHaveBeenCalledTimes(1);
      expect(tx.userMembership.delete).not.toHaveBeenCalled();
      expect(prisma.userMembership.create).not.toHaveBeenCalled();
    });

    it('403s when the caller does not own the destination', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(null);

      const error = await failure(
        service.updateStaff(owner, ONCE, ANA, { tenantId: FOREIGN }),
      );

      expectProblem(error, HttpStatus.FORBIDDEN, ErrorCodes.ENTITY_NO_ACCESS);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // Sin oráculo: para un no-admin, "no existe" y "no es tuyo" dan la misma
    // respuesta, y ni siquiera se consulta si el tenant existe.
    it('gives the same 403 for a non-existent destination', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(null);

      const error = await failure(
        service.updateStaff(owner, ONCE, ANA, { tenantId: FOREIGN }),
      );

      expectProblem(error, HttpStatus.FORBIDDEN, ErrorCodes.ENTITY_NO_ACCESS);
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    });

    // El admin pasa `canManageEntity` con `membership = null`, así que es el
    // único que llega al chequeo de existencia. Sin él, el FK explota como 500.
    it('404s for the global admin when the destination does not exist', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(null);
      prisma.tenant.findUnique.mockResolvedValue(null);

      const error = await failure(
        service.updateStaff(admin, ONCE, ANA, { tenantId: FOREIGN }),
      );

      expectProblem(error, HttpStatus.NOT_FOUND, ErrorCodes.ENTITY_NOT_FOUND);
    });

    it('409s when the person already works at the destination', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(
          membership(BELGRANO, MembershipRole.owner, CALLER),
        )
        .mockResolvedValueOnce(membership(BELGRANO, MembershipRole.operator));

      const error = await failure(
        service.updateStaff(owner, ONCE, ANA, { tenantId: BELGRANO }),
      );

      expectProblem(
        error,
        HttpStatus.CONFLICT,
        ErrorCodes.MEMBERSHIP_ALREADY_EXISTS,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s when moving away the last owner of the origin', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.owner))
        .mockResolvedValueOnce(
          membership(BELGRANO, MembershipRole.owner, CALLER),
        )
        .mockResolvedValueOnce(null);
      tx.userMembership.count.mockResolvedValue(1);

      const error = await failure(
        service.updateStaff(owner, ONCE, ANA, { tenantId: BELGRANO }),
      );

      expectProblem(error, HttpStatus.CONFLICT, ErrorCodes.STAFF_LAST_OWNER);
      expect(tx.userMembership.update).not.toHaveBeenCalled();
    });

    it('treats the URL tenant in the body as a plain role change', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValue(membership(ONCE, MembershipRole.operator));
      tx.userMembership.update.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );

      await service.updateStaff(owner, ONCE, ANA, {
        tenantId: ONCE,
        role: MembershipRole.owner,
      });

      expect(tx.userMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { role: MembershipRole.owner } }),
      );
    });

    it('is a no-op when the body only repeats the URL tenant', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValue(membership(ONCE, MembershipRole.operator));

      await service.updateStaff(owner, ONCE, ANA, { tenantId: ONCE });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('writes inside a single transaction', async () => {
      await service.updateStaff(owner, ONCE, ANA, { tenantId: BELGRANO });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.userMembership.update).toHaveBeenCalled();
    });

    // Una sola fila la vería un solo lote: `audit_log.tenant_id` es el filtro
    // de `listForTenant`, así que el otro dueño nunca se enteraría.
    it('emits one audit row per lot, origin and destination', async () => {
      await service.updateStaff(owner, ONCE, ANA, { tenantId: BELGRANO });

      const [origin, destination] = auditRows();

      expect(auditRows()).toHaveLength(2);

      expect(origin.action).toBe(AuditActions.MEMBERSHIP_DELETED);
      expect(origin.tenantId).toBe(ONCE);
      expect(origin.metadata).toMatchObject({ movedTo: BELGRANO });

      expect(destination.action).toBe(AuditActions.MEMBERSHIP_CREATED);
      expect(destination.tenantId).toBe(BELGRANO);
      expect(destination.metadata).toMatchObject({ movedFrom: ONCE });
    });

    it('lets a global admin move between lots they do not belong to', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.updateStaff(admin, ONCE, ANA, {
        tenantId: BELGRANO,
      });

      expect(result.tenantId).toBe(BELGRANO);
    });
  });

  // ------------------------------------------------------------- removeStaff

  describe('removeStaff', () => {
    beforeEach(() => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.operator),
      );
    });

    it('deletes the membership scoped to the lot', async () => {
      await service.removeStaff(owner, ONCE, ANA);

      expect(tx.userMembership.delete).toHaveBeenCalledWith({
        where: { userId_tenantId: { userId: ANA, tenantId: ONCE } },
      });
    });

    it('403s on your own membership before touching the database', async () => {
      const error = await failure(service.removeStaff(owner, ONCE, CALLER));

      expectProblem(
        error,
        HttpStatus.FORBIDDEN,
        ErrorCodes.STAFF_SELF_MANAGEMENT,
      );
      expect(prisma.userMembership.findUnique).not.toHaveBeenCalled();
    });

    // El segundo DELETE cae acá: el endpoint no es idempotente.
    it('404s when the person does not work at the lot', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(null);

      const error = await failure(service.removeStaff(owner, ONCE, ANA));

      expectProblem(
        error,
        HttpStatus.NOT_FOUND,
        ErrorCodes.MEMBERSHIP_NOT_FOUND,
      );
      expect(tx.userMembership.delete).not.toHaveBeenCalled();
    });

    it('409s when removing the last owner, without deleting', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );
      tx.userMembership.count.mockResolvedValue(1);

      const error = await failure(service.removeStaff(owner, ONCE, ANA));

      expectProblem(error, HttpStatus.CONFLICT, ErrorCodes.STAFF_LAST_OWNER);
      expect(tx.userMembership.delete).not.toHaveBeenCalled();
    });

    it('removes an owner while another one remains', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );
      tx.userMembership.count.mockResolvedValue(2);

      await service.removeStaff(owner, ONCE, ANA);

      expect(tx.userMembership.delete).toHaveBeenCalled();
    });

    it('does not count owners when removing an operator', async () => {
      await service.removeStaff(owner, ONCE, ANA);

      expect(tx.userMembership.count).not.toHaveBeenCalled();
    });

    it('audits the deletion against the lot and the actor', async () => {
      await service.removeStaff(owner, ONCE, ANA);

      const [row] = auditRows();
      expect(row).toMatchObject({
        action: AuditActions.MEMBERSHIP_DELETED,
        entityType: 'user_membership',
        entityId: ANA,
        actorUserId: CALLER,
        tenantId: ONCE,
      });
    });
  });

  // ------------------------------------------------------ tenant isolation

  // `UserMembership` está fuera de `TENANT_MODELS`, así que `getTenantClient`
  // no filtraría nada: el scoping tiene que ser explícito en cada query. Los
  // mocks de arriba no declaran `updateMany`/`deleteMany` a propósito — si
  // alguien los introduce en el service, la suite explota en vez de pasar.
  describe('multi-tenant isolation', () => {
    it('scopes the owner count to the lot being emptied', async () => {
      prisma.userMembership.findUnique.mockResolvedValue(
        membership(ONCE, MembershipRole.owner),
      );
      tx.userMembership.count.mockResolvedValue(2);

      await service.removeStaff(owner, ONCE, ANA);

      expect(tx.userMembership.count).toHaveBeenCalledWith({
        where: { tenantId: ONCE, role: MembershipRole.owner },
      });
    });

    it('proves ownership of the destination before writing anything', async () => {
      prisma.userMembership.findUnique
        .mockReset()
        .mockResolvedValueOnce(membership(ONCE, MembershipRole.operator))
        .mockResolvedValueOnce(null);

      await failure(
        service.updateStaff(owner, ONCE, ANA, { tenantId: FOREIGN }),
      );

      expect(prisma.userMembership.findUnique).toHaveBeenCalledWith({
        where: { userId_tenantId: { userId: CALLER, tenantId: FOREIGN } },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
