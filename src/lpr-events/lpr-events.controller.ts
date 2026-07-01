import {
  Body,
  Controller,
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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { LprDetectionEventChangesQueryDto } from './dto/lpr-detection-event-changes-query.dto';
import { LprDetectionEventChangesResponseDto } from './dto/lpr-detection-event-changes-response.dto';
import { LprDetectionEventDto } from './dto/lpr-detection-event.dto';
import { ListLprDetectionEventsQueryDto } from './dto/list-lpr-detection-events-query.dto';
import { UpdateLprDetectionEventDto } from './dto/update-lpr-detection-event.dto';
import { UpsertLprDetectionEventDto } from './dto/upsert-lpr-detection-event.dto';
import { LprEventsService } from './lpr-events.service';

@ApiTags('LPR Events')
@Controller('tenants/:tenantId/lpr-events')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
@ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
export class LprEventsController {
  constructor(private readonly lprEvents: LprEventsService) {}

  @Get()
  @ApiOperation({
    summary: 'List LPR detection events for owner/operator review',
  })
  @ApiOkResponse({ type: [LprDetectionEventDto] })
  async list(@Query() query: ListLprDetectionEventsQueryDto) {
    return this.lprEvents.list(query);
  }

  @Get('changes')
  @ApiOperation({
    summary: 'Pull incremental LPR detection event changes for sync',
  })
  @ApiOkResponse({ type: LprDetectionEventChangesResponseDto })
  async pullChanges(@Query() query: LprDetectionEventChangesQueryDto) {
    return this.lprEvents.pullChanges(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Create or update an auditable LPR detection event',
  })
  @ApiOkResponse({ type: LprDetectionEventDto })
  async upsert(
    @Body() dto: UpsertLprDetectionEventDto,
    @CurrentUser() user: User,
  ) {
    return this.lprEvents.upsert(dto, user);
  }

  @Patch(':eventId')
  @ApiOperation({
    summary:
      'Mark an LPR detection event as registered, dismissed, or suppressed',
  })
  @ApiOkResponse({ type: LprDetectionEventDto })
  async updateStatus(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: UpdateLprDetectionEventDto,
    @CurrentUser() user: User,
  ) {
    return this.lprEvents.updateStatus(eventId, dto, user);
  }
}
