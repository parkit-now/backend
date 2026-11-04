import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MembershipRole, type UserMembership } from '@prisma/client';
import {
  CurrentMembership,
  EntityRole,
} from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import {
  CreatePlateProfileDto,
  DeletePlateProfileDto,
  PlateProfileChangesDto,
  PlateProfileChangesQueryDto,
  PlateProfileDto,
  UpdatePlateProfileDto,
} from './dto/plate-profile.dto';
import { PlateProfilesService } from './plate-profiles.service';

@ApiTags('Plate profiles')
@ApiBearerAuth()
@Controller('tenants/:tenantId/plate-profiles')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
export class PlateProfilesController {
  constructor(private readonly service: PlateProfilesService) {}
  private owner(membership: UserMembership | null) {
    if (membership?.role !== MembershipRole.owner)
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Only parking owners can manage plate profiles.',
        '/plate-profiles',
        ErrorCodes.ENTITY_INSUFFICIENT_ROLE,
      );
  }
  @Get()
  @ApiOkResponse({ type: [PlateProfileDto] })
  list() {
    return this.service.list();
  }
  @Get('changes')
  @ApiOkResponse({ type: PlateProfileChangesDto })
  changes(@Query() query: PlateProfileChangesQueryDto) {
    return this.service.changes(query);
  }
  @Get(':plate')
  @ApiOkResponse({ type: PlateProfileDto })
  get(@Param('plate') plate: string) {
    return this.service.get(plate);
  }
  @Post()
  @EntityRole(MembershipRole.owner)
  @ApiCreatedResponse({ type: PlateProfileDto })
  create(
    @Body() body: CreatePlateProfileDto,
    @CurrentMembership() membership: UserMembership | null,
  ) {
    this.owner(membership);
    return this.service.mutate(body.plate, body, 'create');
  }
  @Patch(':plate')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: PlateProfileDto })
  update(
    @Param('plate') plate: string,
    @Body() body: UpdatePlateProfileDto,
    @CurrentMembership() membership: UserMembership | null,
  ) {
    this.owner(membership);
    return this.service.mutate(plate, body, 'update');
  }
  @Delete(':plate')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: PlateProfileDto })
  remove(
    @Param('plate') plate: string,
    @Body() body: DeletePlateProfileDto,
    @CurrentMembership() membership: UserMembership | null,
  ) {
    this.owner(membership);
    return this.service.mutate(plate, body, 'delete');
  }
}
