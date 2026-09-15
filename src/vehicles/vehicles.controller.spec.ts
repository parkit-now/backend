import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole } from '@prisma/client';
import { ENTITY_ROLE_KEY } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

describe('VehiclesController', () => {
  let controller: VehiclesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [
        { provide: VehiclesService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        TenantContextService,
        TenantInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantMembershipGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<VehiclesController>(VehiclesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  /**
   * Protege una decisión que es fácil de romper sin querer: las lecturas son
   * para cualquier miembro (el autocompletado del desktop las necesita) y las
   * mutaciones son owner-only.
   */
  it('deja las lecturas abiertas a cualquier miembro y las mutaciones en owner', () => {
    const reflector = new Reflector();

    // Los handlers se pasan desreferenciados a propósito: `Reflector.get` solo
    // LEE la metadata que colgó el decorador, nunca los invoca, así que no hay
    // ningún `this` que se pueda perder.
    /* eslint-disable @typescript-eslint/unbound-method */

    for (const handler of [
      VehiclesController.prototype.list,
      VehiclesController.prototype.pullChanges,
    ]) {
      expect(
        reflector.get<MembershipRole>(ENTITY_ROLE_KEY, handler),
      ).toBeUndefined();
    }

    for (const handler of [
      VehiclesController.prototype.create,
      VehiclesController.prototype.update,
      VehiclesController.prototype.remove,
    ]) {
      expect(reflector.get<MembershipRole>(ENTITY_ROLE_KEY, handler)).toBe(
        MembershipRole.owner,
      );
    }
    /* eslint-enable @typescript-eslint/unbound-method */
  });
});
