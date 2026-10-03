import type { User, UserMembership } from '@prisma/client';
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
const USER = { id: 'user-op' } as User;
const MEMBERSHIP = { role: 'operator' } as UserMembership;
const OPERATOR = { userId: 'user-op', role: 'operator' } as const;

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
    void controller.accept(TENANT, RES, USER, MEMBERSHIP);
    void controller.reject(
      TENANT,
      RES,
      { reason: 'no hay lugar' },
      USER,
      MEMBERSHIP,
    );
    void controller.cancel(TENANT, RES, { reason: 'cierre' }, USER, MEMBERSHIP);
    void controller.retryRefund(TENANT, RES, USER, MEMBERSHIP);

    expect(service.list).toHaveBeenCalledWith(query);
    expect(service.get).toHaveBeenCalledWith(TENANT, RES);
    expect(service.accept).toHaveBeenCalledWith(TENANT, RES, OPERATOR);
    expect(service.reject).toHaveBeenCalledWith(
      TENANT,
      RES,
      'no hay lugar',
      OPERATOR,
    );
    expect(service.cancel).toHaveBeenCalledWith(
      TENANT,
      RES,
      'cierre',
      OPERATOR,
    );
    expect(service.retryRefund).toHaveBeenCalledWith(TENANT, RES, OPERATOR);
  });

  it('el actor es el rol de la membresía, o admin si no tiene', () => {
    void controller.accept(TENANT, RES, USER, {
      role: 'owner',
    } as UserMembership);
    void controller.accept(TENANT, RES, USER, null);
    expect(service.accept).toHaveBeenCalledWith(TENANT, RES, {
      userId: USER.id,
      role: 'owner',
    });
    expect(service.accept).toHaveBeenCalledWith(TENANT, RES, {
      userId: USER.id,
      role: 'admin',
    });
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
