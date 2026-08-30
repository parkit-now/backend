import { Test, TestingModule } from '@nestjs/testing';
import { MembershipRole, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginatedStaffDto } from './dto/paginated-staff.dto';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

describe('StaffController', () => {
  let controller: StaffController;

  const mockStaffService = { listStaff: jest.fn() };
  const caller = { id: 'user-owner' } as User;
  const empty: PaginatedStaffDto = {
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StaffController],
      providers: [{ provide: StaffService, useValue: mockStaffService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<StaffController>(StaffController);
    jest.clearAllMocks();
    mockStaffService.listStaff.mockResolvedValue(empty);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('hands the caller to the service, which derives the scope from it', () => {
    // The scope is not a query parameter: it comes from who is asking. If the
    // controller ever stopped passing the user, every caller would share one
    // scope — so assert the wiring explicitly.
    void controller.list(caller, {});

    expect(mockStaffService.listStaff).toHaveBeenCalledWith(caller, {});
  });

  it('passes the filters through untouched', () => {
    const query = {
      search: 'ana',
      role: MembershipRole.operator,
      page: 2,
      pageSize: 10,
    };

    void controller.list(caller, query);

    expect(mockStaffService.listStaff).toHaveBeenCalledWith(caller, query);
  });
});
