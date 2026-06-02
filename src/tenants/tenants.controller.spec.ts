import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

const caller = { id: 'user-1' } as User;

describe('TenantsController', () => {
  let controller: TenantsController;
  const mockService = { listMine: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [{ provide: TenantsService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TenantsController>(TenantsController);
  });

  it('delegates to the service with the caller and role filter', async () => {
    const summaries = [{ tenantId: 't-1', role: 'owner' }];
    mockService.listMine.mockResolvedValue(summaries);

    const result = await controller.listMine(caller, { role: 'owner' });

    expect(result).toBe(summaries);
    expect(mockService.listMine).toHaveBeenCalledWith(caller, 'owner');
  });
});
