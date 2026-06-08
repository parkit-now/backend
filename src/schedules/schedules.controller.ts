import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ExpectedVersionQueryDto } from './dto/expected-version-query.dto';
import { ListSchedulesQueryDto } from './dto/list-schedules-query.dto';
import { ScheduleChangesQueryDto } from './dto/schedule-changes-query.dto';
import { ScheduleChangesResponseDto } from './dto/schedule-changes-response.dto';
import { ScheduleDto } from './dto/schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { SchedulesService } from './schedules.service';

@ApiTags('Schedules')
@Controller('tenants/:tenantId/schedules')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Get()
  @ApiOperation({ summary: 'List opening ranges in the active tenant' })
  @ApiOkResponse({ type: [ScheduleDto] })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async findAll(@Query() query: ListSchedulesQueryDto) {
    return this.schedulesService.listSchedules(query);
  }

  @Get('changes')
  @ApiOperation({ summary: 'Pull incremental changes for offline sync' })
  @ApiOkResponse({ type: ScheduleChangesResponseDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async pullChanges(@Query() query: ScheduleChangesQueryDto) {
    return this.schedulesService.pullChanges(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @ApiOperation({ summary: 'Create an opening range (validates overlaps)' })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async create(@Body() dto: CreateScheduleDto) {
    return this.schedulesService.createSchedule(dto);
  }

  @Patch(':scheduleId')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary:
      'Update an opening range using optimistic locking (expectedVersion)',
  })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async update(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.schedulesService.updateSchedule(
      scheduleId,
      query.expectedVersion,
      dto,
    );
  }

  @Delete(':scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary:
      'Delete an opening range using optimistic locking (expectedVersion)',
  })
  @ApiNoContentResponse({ description: 'Schedule deleted successfully' })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async remove(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Query() query: ExpectedVersionQueryDto,
  ) {
    return this.schedulesService.deleteSchedule(
      scheduleId,
      query.expectedVersion,
    );
  }
}
