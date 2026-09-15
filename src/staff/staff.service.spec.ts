import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole, User, UserRole } from '@prisma/client';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { StaffService } from './staff.service';

const ONCE = 'tenant-once';
const BELGRANO = 'tenant-belgrano';
const FOREIGN = 'tenant-someone-elses';

describe('StaffService', () => {
  let service: StaffService;

  const mockPrisma = {
    user: { findMany: jest.fn(), count: jest.fn() },
    userMembership: { findMany: jest.fn() },
    tenant: { findMany: jest.fn() },
    // The service pairs findMany+count in one transaction; resolve them in order.
    $transaction: jest.fn(),
  };

  const owner = {
    id: 'user-owner',
    role: UserRole.user,
    email: 'owner@example.com',
    name: 'Olivia Owner',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  } as User;

  const admin = { ...owner, id: 'user-admin', role: UserRole.admin } as User;

  const membership = (
    tenantId: string,
    name: string,
    role: MembershipRole,
  ) => ({
    userId: 'user-1',
    tenantId,
    role,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    tenant: { id: tenantId, name },
  });

  const staffRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    role: UserRole.user,
    email: 'ana@example.com',
    name: 'Ana',
    createdAt: new Date('2026-01-15T00:00:00Z'),
    memberships: [membership(ONCE, 'Once', MembershipRole.operator)],
    ...overrides,
  });

  /** Owner of Once + Belgrano, unless a test says otherwise. */
  const ownsBoth = () =>
    mockPrisma.userMembership.findMany.mockResolvedValue([
      { tenantId: ONCE },
      { tenantId: BELGRANO },
    ]);

  const returns = (rows: unknown[], total = rows.length) =>
    mockPrisma.$transaction.mockResolvedValue([rows, total]);

  /** Membership filter, as it appears on both the outer `where` and the include. */
  type MembershipFilter = {
    tenantId?: { in: string[] };
    role?: MembershipRole;
  };

  /** The arguments the service handed to `user.findMany`. */
  type StaffFindManyArgs = {
    where: {
      // Always present: the service short-circuits before querying when the
      // caller's scope is empty, so any recorded call carries this filter.
      memberships: { some: MembershipFilter };
      OR?: Record<string, unknown>[];
    };
    include: { memberships: { where: MembershipFilter } };
    skip: number;
    take: number;
  };

  const findManyArgs = (): StaffFindManyArgs =>
    mockPrisma.user.findMany.mock.calls[0]?.[0] as StaffFindManyArgs;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: mockPrisma },
        PermissionsService,
      ],
    }).compile();

    service = module.get<StaffService>(StaffService);
    jest.clearAllMocks();
    returns([]);
    mockPrisma.tenant.findMany.mockResolvedValue([]);
    mockPrisma.userMembership.findMany.mockResolvedValue([]);
  });

  describe('scope', () => {
    it('limits the query to lots the caller owns', async () => {
      ownsBoth();

      await service.listStaff(owner, {});

      expect(mockPrisma.userMembership.findMany).toHaveBeenCalledWith({
        where: { userId: owner.id, role: MembershipRole.owner },
        select: { tenantId: true },
      });
      expect(findManyArgs().where.memberships.some.tenantId).toEqual({
        in: [ONCE, BELGRANO],
      });
    });

    it('scopes the included memberships too, not just who is listed', async () => {
      ownsBoth();

      await service.listStaff(owner, {});

      // Without this the row would expose a person's roles at other people's
      // lots, which is the whole risk of a cross-tenant endpoint.
      expect(findManyArgs().include.memberships.where.tenantId).toEqual({
        in: [ONCE, BELGRANO],
      });
    });

    it('returns an empty page when the caller owns nothing', async () => {
      mockPrisma.userMembership.findMany.mockResolvedValue([]);

      const result = await service.listStaff(owner, {});

      expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
      // Never reaches the database for users at all.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects narrowing to a lot the caller does not own', async () => {
      ownsBoth();

      const failure = await service
        .listStaff(owner, { tenantId: FOREIGN })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FormattedException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('allows narrowing to one owned lot', async () => {
      ownsBoth();

      await service.listStaff(owner, { tenantId: BELGRANO });

      expect(findManyArgs().where.memberships.some.tenantId).toEqual({
        in: [BELGRANO],
      });
    });

    it('gives admins every lot without consulting memberships', async () => {
      mockPrisma.tenant.findMany.mockResolvedValue([
        { id: ONCE },
        { id: FOREIGN },
      ]);

      await service.listStaff(admin, {});

      expect(mockPrisma.userMembership.findMany).not.toHaveBeenCalled();
      expect(findManyArgs().where.memberships.some.tenantId).toEqual({
        in: [ONCE, FOREIGN],
      });
    });
  });

  describe('listing', () => {
    it('groups a person into one row carrying every role they hold', async () => {
      ownsBoth();
      returns([
        staffRow({
          memberships: [
            membership(ONCE, 'Once', MembershipRole.operator),
            membership(BELGRANO, 'Belgrano', MembershipRole.owner),
          ],
        }),
      ]);

      const result = await service.listStaff(owner, {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].memberships).toEqual([
        {
          tenantId: ONCE,
          tenantName: 'Once',
          role: MembershipRole.operator,
          createdAt: new Date('2026-02-01T00:00:00Z'),
        },
        {
          tenantId: BELGRANO,
          tenantName: 'Belgrano',
          role: MembershipRole.owner,
          createdAt: new Date('2026-02-01T00:00:00Z'),
        },
      ]);
      expect(result.items[0].globalRole).toBe(UserRole.user);
    });

    it('searches name and email case-insensitively', async () => {
      ownsBoth();

      await service.listStaff(owner, { search: '  ana  ' });

      expect(findManyArgs().where.OR).toEqual([
        { name: { contains: 'ana', mode: 'insensitive' } },
        { email: { contains: 'ana', mode: 'insensitive' } },
      ]);
    });

    it('ignores a blank search rather than matching everything', async () => {
      ownsBoth();

      await service.listStaff(owner, { search: '   ' });

      expect(findManyArgs().where.OR).toBeUndefined();
    });

    it('filters who is listed by role', async () => {
      ownsBoth();

      await service.listStaff(owner, { role: MembershipRole.operator });

      expect(findManyArgs().where.memberships.some.role).toBe(
        MembershipRole.operator,
      );
      // ...but the include stays unfiltered, so a listed person still shows
      // their other roles.
      expect(findManyArgs().include.memberships.where.role).toBeUndefined();
    });

    it('paginates over people and reports the total', async () => {
      ownsBoth();
      returns([staffRow()], 42);

      const result = await service.listStaff(owner, { page: 3, pageSize: 5 });

      expect(findManyArgs().skip).toBe(10);
      expect(findManyArgs().take).toBe(5);
      expect(result).toMatchObject({ page: 3, pageSize: 5, total: 42 });
    });
  });
});
