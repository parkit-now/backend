import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole } from '@prisma/client';
import { ENTITY_ROLE_KEY } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { VehicleTypesController } from './vehicle-types.controller';
import { VehicleTypesService } from './vehicle-types.service';

describe('VehicleTypesController', () => {
  let controller: VehicleTypesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VehicleTypesController],
      providers: [
        { provide: VehicleTypesService, useValue: {} },
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

    controller = module.get<VehicleTypesController>(VehicleTypesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  /**
   * Protege una decisión fácil de romper sin querer: las lecturas son para
   * cualquier miembro (el desktop necesita los tipos para operar) y las
   * mutaciones son owner-only.
   */
  it('deja las lecturas abiertas a cualquier miembro y las mutaciones en owner', () => {
    const reflector = new Reflector();

    // Los handlers se pasan desreferenciados a propósito: `Reflector.get` sólo
    // LEE la metadata que colgó el decorador, nunca los invoca.
    /* eslint-disable @typescript-eslint/unbound-method */
    for (const handler of [
      VehicleTypesController.prototype.list,
      VehicleTypesController.prototype.pullChanges,
    ]) {
      expect(reflector.get(ENTITY_ROLE_KEY, handler)).toBeUndefined();
    }

    for (const handler of [
      VehicleTypesController.prototype.create,
      VehicleTypesController.prototype.update,
      VehicleTypesController.prototype.remove,
    ]) {
      expect(reflector.get(ENTITY_ROLE_KEY, handler)).toBe(
        MembershipRole.owner,
      );
    }
    /* eslint-enable @typescript-eslint/unbound-method */
  });
});
