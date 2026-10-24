import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { AuditActions, AuditService } from '../../audit/audit.service';
import { SupabaseAuthService } from '../../auth/supabase-auth.service';
import { PrismaService } from '../../database/prisma.service';
import { ErrorCodes } from '../../utils/exceptions/error-codes';
import { AdminUsersService } from './admin-users.service';

const admin: User = {
  id: 'admin-1',
  role: 'admin',
  email: 'admin@parkit.test',
  name: 'Admin',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
};

const ana: User = {
  id: 'ana',
  role: 'user',
  email: 'ana@parkit.test',
  name: 'Ana Pérez',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
};

const tenant = {
  id: 'p-1',
  name: 'Playa Once',
  deletedAt: null,
};

function membership(role: 'owner' | 'operator' = 'operator') {
  return {
    userId: 'ana',
    tenantId: 'p-1',
    role,
    createdAt: new Date('2026-06-02T00:00:00.000Z'),
    tenant,
  };
}

describe('AdminUsersService', () => {
  let service: AdminUsersService;

  const mockPrisma = {
    user: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    tenant: { findUnique: jest.fn() },
    userMembership: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn() };
  const mockSupabase = { deleteUser: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    mockPrisma.user.findUnique.mockResolvedValue(ana);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: SupabaseAuthService, useValue: mockSupabase },
      ],
    }).compile();

    service = module.get(AdminUsersService);
  });

  describe('list', () => {
    it('pagina y busca por nombre o email sin distinguir mayúsculas', async () => {
      mockPrisma.user.findMany.mockResolvedValue([ana]);
      mockPrisma.user.count.mockResolvedValue(1);

      const result = await service.list({
        search: '  ana ',
        page: 2,
        pageSize: 10,
      });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { name: { contains: 'ana', mode: 'insensitive' } },
              { email: { contains: 'ana', mode: 'insensitive' } },
            ],
          },
          skip: 10,
          take: 10,
        }),
      );
      expect(result).toEqual({
        items: [
          {
            id: 'ana',
            email: 'ana@parkit.test',
            name: 'Ana Pérez',
            role: 'user',
            createdAt: ana.createdAt,
          },
        ],
        total: 1,
        page: 2,
        pageSize: 10,
      });
    });

    it('sin búsqueda no filtra', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await service.list({ search: '   ' });

      expect(mockPrisma.user.count).toHaveBeenCalledWith({ where: {} });
    });
  });

  describe('getDetail', () => {
    it('devuelve el usuario con sus estacionamientos', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...ana,
        memberships: [membership('owner')],
      });

      const result = await service.getDetail('ana');

      expect(result.memberships).toEqual([
        {
          parkingId: 'p-1',
          parkingName: 'Playa Once',
          role: 'owner',
          createdAt: membership().createdAt,
          parkingDeletedAt: null,
        },
      ]);
    });

    it('404 USER_NOT_FOUND si no existe', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.getDetail('nadie')).rejects.toMatchObject({
        response: { code: ErrorCodes.USER_NOT_FOUND, status: 404 },
      });
    });
  });

  it('cambia el rol global y lo audita', async () => {
    mockPrisma.user.update.mockResolvedValue({ ...ana, role: 'admin' });

    const result = await service.updateRole(admin, 'ana', { role: 'admin' });

    expect(result.role).toBe('admin');
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditActions.USER_ROLE_UPDATED,
        entityId: 'ana',
        actorUserId: 'admin-1',
        metadata: { role: 'admin' },
      }),
    );
  });

  it('borra el usuario en Supabase y audita su email', async () => {
    await service.remove(admin, 'ana');

    expect(mockSupabase.deleteUser).toHaveBeenCalledWith('ana');
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditActions.USER_DELETED,
        metadata: { email: 'ana@parkit.test' },
      }),
    );
  });

  it('no borra un usuario inexistente', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(service.remove(admin, 'nadie')).rejects.toMatchObject({
      response: { code: ErrorCodes.USER_NOT_FOUND },
    });
    expect(mockSupabase.deleteUser).not.toHaveBeenCalled();
  });

  describe('addMembership', () => {
    it('vincula al usuario con el estacionamiento', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant);
      mockPrisma.userMembership.findUnique.mockResolvedValue(null);
      mockPrisma.userMembership.create.mockResolvedValue(membership());

      const result = await service.addMembership(admin, 'ana', {
        parkingId: 'p-1',
        role: 'operator',
      });

      expect(result).toMatchObject({ parkingId: 'p-1', role: 'operator' });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditActions.MEMBERSHIP_CREATED,
          tenantId: 'p-1',
        }),
      );
    });

    it('404 PARKING_NOT_FOUND si el estacionamiento no existe', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.addMembership(admin, 'ana', {
          parkingId: 'p-x',
          role: 'owner',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.PARKING_NOT_FOUND },
      });
    });

    it('409 MEMBERSHIP_ALREADY_EXISTS si ya estaba vinculado', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(tenant);
      mockPrisma.userMembership.findUnique.mockResolvedValue(membership());

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.addMembership(admin, 'ana', {
          parkingId: 'p-1',
          role: 'owner',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.MEMBERSHIP_ALREADY_EXISTS, status: 409 },
      });
      expect(mockPrisma.userMembership.create).not.toHaveBeenCalled();
    });
  });

  describe('relaciones existentes', () => {
    it('cambia el rol de la relación', async () => {
      mockPrisma.userMembership.findUnique.mockResolvedValue(membership());
      mockPrisma.userMembership.update.mockResolvedValue(membership('owner'));

      const result = await service.updateMembership(admin, 'ana', 'p-1', {
        role: 'owner',
      });

      expect(result.role).toBe('owner');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditActions.MEMBERSHIP_UPDATED }),
      );
    });

    it('quita la relación', async () => {
      mockPrisma.userMembership.findUnique.mockResolvedValue(membership());

      await service.removeMembership(admin, 'ana', 'p-1');

      expect(mockPrisma.userMembership.delete).toHaveBeenCalledWith({
        where: { userId_tenantId: { userId: 'ana', tenantId: 'p-1' } },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditActions.MEMBERSHIP_DELETED }),
      );
    });

    it('404 MEMBERSHIP_NOT_FOUND si no había relación', async () => {
      mockPrisma.userMembership.findUnique.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.removeMembership(admin, 'ana', 'p-9'),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.MEMBERSHIP_NOT_FOUND },
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.updateMembership(admin, 'ana', 'p-9', { role: 'owner' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.MEMBERSHIP_NOT_FOUND },
      });
    });
  });
});
