import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Tenant, User } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ApplicationsController } from './applications/applications.controller';
import type { ApplicationsService } from './applications/applications.service';
import type { ParkingDeletionService } from './parkings/parking-deletion.service';
import { ParkingsController } from './parkings/parkings.controller';
import type { ParkingsService } from './parkings/parkings.service';
import { AdminUsersController } from './users/admin-users.controller';
import type { AdminUsersService } from './users/admin-users.service';

const admin = { id: 'admin-1', role: 'admin' } as User;

const tenant = {
  id: 'p-1',
  name: 'Playa Once',
  legalName: null,
  cuit: null,
  email: null,
  phone: null,
  address: null,
  status: 'active',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  purgeAfter: new Date('2026-10-31T00:00:00.000Z'),
} as Tenant;

type Fake = Record<string, ReturnType<typeof jest.fn>>;

/** Un servicio falso cuyos métodos devuelven el nombre del método. */
function fakeService(...methods: string[]): Fake {
  return Object.fromEntries(
    methods.map((method) => [method, jest.fn(() => Promise.resolve(method))]),
  );
}

describe('controllers de administración', () => {
  it.each([AdminUsersController, ParkingsController, ApplicationsController])(
    '%p exige JWT y rol admin',
    (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual(['admin']);
    },
  );

  it('usuarios: cada endpoint delega en el servicio', async () => {
    const service = fakeService(
      'list',
      'getDetail',
      'updateRole',
      'remove',
      'addMembership',
      'updateMembership',
      'removeMembership',
    );
    const controller = new AdminUsersController(
      service as unknown as AdminUsersService,
    );

    await controller.list({ search: 'ana' });
    await controller.detail('ana');
    await controller.updateRole(admin, 'ana', { role: 'admin' });
    await controller.remove(admin, 'ana');
    await controller.addMembership(admin, 'ana', {
      parkingId: 'p-1',
      role: 'owner',
    });
    await controller.updateMembership(admin, 'ana', 'p-1', {
      role: 'operator',
    });
    await controller.removeMembership(admin, 'ana', 'p-1');

    expect(service.list).toHaveBeenCalledWith({ search: 'ana' });
    expect(service.getDetail).toHaveBeenCalledWith('ana');
    expect(service.updateRole).toHaveBeenCalledWith(admin, 'ana', {
      role: 'admin',
    });
    expect(service.remove).toHaveBeenCalledWith(admin, 'ana');
    expect(service.addMembership).toHaveBeenCalledWith(admin, 'ana', {
      parkingId: 'p-1',
      role: 'owner',
    });
    expect(service.updateMembership).toHaveBeenCalledWith(admin, 'ana', 'p-1', {
      role: 'operator',
    });
    expect(service.removeMembership).toHaveBeenCalledWith(admin, 'ana', 'p-1');
  });

  it('estacionamientos: ABM, baja y restauración', async () => {
    const parkings = fakeService('list', 'get', 'create', 'update');
    const deletion = fakeService('preflight');
    deletion.delete = jest.fn(() =>
      Promise.resolve({ tenant, effects: [{ effect: 'arca', ok: true }] }),
    );
    deletion.restore = jest.fn(() =>
      Promise.resolve({ ...tenant, deletedAt: null }),
    );
    const controller = new ParkingsController(
      parkings as unknown as ParkingsService,
      deletion as unknown as ParkingDeletionService,
    );

    await controller.list({});
    await controller.get('p-1');
    await controller.create(admin, { name: 'Playa' });
    await controller.update(admin, 'p-1', { name: 'Playa 2' });
    await controller.preflight('p-1');
    const deleted = await controller.delete(admin, 'p-1', {
      confirmName: 'Playa Once',
    });
    const restored = await controller.restore(admin, 'p-1');

    expect(parkings.create).toHaveBeenCalledWith(admin, { name: 'Playa' });
    expect(parkings.update).toHaveBeenCalledWith(admin, 'p-1', {
      name: 'Playa 2',
    });
    expect(deletion.preflight).toHaveBeenCalledWith('p-1');
    expect(deleted).toMatchObject({
      parking: { id: 'p-1', purgeAfter: tenant.purgeAfter },
      effects: [{ effect: 'arca', ok: true }],
    });
    expect(restored).toMatchObject({ id: 'p-1', deletedAt: null });
  });

  it('solicitudes: revisión y resolución', async () => {
    const service = fakeService(
      'list',
      'getDetail',
      'getDocumentSignedUrl',
      'approve',
      'reject',
    );
    const controller = new ApplicationsController(
      service as unknown as ApplicationsService,
    );

    await controller.list({ status: 'pending' } as never);
    await controller.detail('a-1');
    await controller.documentSignedUrl('a-1', 'd-1', {
      disposition: 'inline',
    } as never);
    await controller.approve(admin, 'a-1');
    await controller.reject(admin, 'a-1', { reason: 'sin habilitación' });

    expect(service.getDocumentSignedUrl).toHaveBeenCalledWith(
      'a-1',
      'd-1',
      'inline',
    );
    expect(service.approve).toHaveBeenCalledWith(admin, 'a-1');
    expect(service.reject).toHaveBeenCalledWith(admin, 'a-1', {
      reason: 'sin habilitación',
    });
  });
});
