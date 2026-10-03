import { Test } from '@nestjs/testing';
import { ENTITY_ROLE_KEY } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { OwnerReservationsController } from './owner-reservations.controller';
import { OwnerReservationsService } from './owner-reservations.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RES = '0192f0a0-0000-7000-8000-00000000abcd';

describe('OwnerReservationsController', () => {
  const service = {
    list: jest.fn(),
    get: jest.fn(),
    accept: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
    retryRefund: jest.fn(),
  };
  let controller: OwnerReservationsController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [OwnerReservationsController],
      providers: [
        { provide: OwnerReservationsService, useValue: service },
        { provide: PrismaService, useValue: {} },
        TenantContextService,
        TenantInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantMembershipGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(OwnerReservationsController);
  });

  it('delega cada operación en el servicio con el tenant de la ruta', () => {
    const query = { page: 1, pageSize: 20 };
    void controller.list(query);
    void controller.get(TENANT, RES);
    void controller.accept(TENANT, RES);
    void controller.reject(TENANT, RES, { reason: 'no hay lugar' });
    void controller.cancel(TENANT, RES, { reason: 'cierre' });
    void controller.retryRefund(TENANT, RES);

    expect(service.list).toHaveBeenCalledWith(query);
    expect(service.get).toHaveBeenCalledWith(TENANT, RES);
    expect(service.accept).toHaveBeenCalledWith(TENANT, RES);
    expect(service.reject).toHaveBeenCalledWith(TENANT, RES, 'no hay lugar');
    expect(service.cancel).toHaveBeenCalledWith(TENANT, RES, 'cierre');
    expect(service.retryRefund).toHaveBeenCalledWith(TENANT, RES);
  });

  it('no exige @EntityRole: el dueño y el operador pueden actuar', () => {
    const proto = OwnerReservationsController.prototype;
    for (const name of [
      'list',
      'get',
      'accept',
      'reject',
      'cancel',
      'retryRefund',
    ] as const) {
      expect(Reflect.getMetadata(ENTITY_ROLE_KEY, proto[name])).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(ENTITY_ROLE_KEY, OwnerReservationsController),
    ).toBeUndefined();
  });
});
