import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { TenantContextService } from '../database/tenant-context.service';
import { EntriesService } from './entries.service';

describe('EntriesService', () => {
  let service: EntriesService;

  const mockTenant = {
    entry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockPrisma = {
    // Simulamos el método getTenantClient
    getTenantClient: jest.fn().mockReturnValue(mockTenant),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntriesService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        // `EntriesService` lo inyecta para resolver el tenant activo desde el
        // AsyncLocalStorage. Sin registrarlo, Nest no puede construir el
        // service y el `beforeEach` explota antes del primer `it`.
        TenantContextService,
      ],
    }).compile();

    service = module.get<EntriesService>(EntriesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should call prisma with the correct tenant isolation', async () => {
      const mockEntries = [{ id: '1', plate: 'AAA111' }];

      // Mockeamos el valor de retorno del findMany dentro de tenant
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (mockTenant.entry.findMany as jest.Mock).mockResolvedValue(mockEntries);

      const result = await service.findAll();

      // `findAll` mapea por `toDto`, así que el resultado NO es la fila cruda:
      // es el DTO completo con el resto de los campos en undefined. Se asertan
      // los campos que sí viajan, no la identidad del objeto.
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: '1', plate: 'AAA111' });

      // Lo que este test cuida de verdad: el aislamiento por tenant.
      expect(mockPrisma.getTenantClient).toHaveBeenCalled();
      expect(mockTenant.entry.findMany).toHaveBeenCalledWith({
        orderBy: [{ enteredAt: 'desc' }],
      });
    });
  });
});
