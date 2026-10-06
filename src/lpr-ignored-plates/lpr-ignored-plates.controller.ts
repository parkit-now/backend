import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
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
import { MembershipRole } from '@prisma/client';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ExpectedVersionQueryDto } from '../vehicles/dto/expected-version-query.dto';
import {
  CreateLprIgnoredPlateDto,
  LprIgnoredPlateChangesDto,
  LprIgnoredPlateChangesQueryDto,
  LprIgnoredPlateDto,
  UpdateLprIgnoredPlateDto,
} from './dto/lpr-ignored-plate.dto';
import { LprIgnoredPlatesService } from './lpr-ignored-plates.service';

@ApiTags('LPR ignored plates')
@ApiBearerAuth()
@Controller('tenants/:tenantId/lpr-ignored-plates')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
export class LprIgnoredPlatesController {
  constructor(private readonly service: LprIgnoredPlatesService) {}

  @Get()
  @ApiOkResponse({ type: [LprIgnoredPlateDto] })
  list() {
    return this.service.list();
  }

  @Get('changes')
  @ApiOkResponse({ type: LprIgnoredPlateChangesDto })
  changes(@Query() query: LprIgnoredPlateChangesQueryDto) {
    return this.service.changes(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @ApiCreatedResponse({ type: LprIgnoredPlateDto })
  create(@Body() input: CreateLprIgnoredPlateDto) {
    return this.service.create(input);
  }

  @Patch(':id')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: LprIgnoredPlateDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() input: UpdateLprIgnoredPlateDto,
  ) {
    return this.service.update(id, query.expectedVersion, input);
  }

  @Delete(':id')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: LprIgnoredPlateDto })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ExpectedVersionQueryDto,
  ) {
    return this.service.remove(id, query.expectedVersion);
  }
}
