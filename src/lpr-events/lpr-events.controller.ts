import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { MembershipRole, type User } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { LprDetectionEventChangesQueryDto } from './dto/lpr-detection-event-changes-query.dto';
import { LprDetectionEventChangesResponseDto } from './dto/lpr-detection-event-changes-response.dto';
import { LprDetectionEventDto } from './dto/lpr-detection-event.dto';
import { LprDetectionEventImageSignedUrlDto } from './dto/lpr-detection-event-image-signed-url.dto';
import { ListLprDetectionEventsQueryDto } from './dto/list-lpr-detection-events-query.dto';
import { PaginatedLprDetectionEventsDto } from './dto/paginated-lpr-detection-events.dto';
import { UpdateLprDetectionEventDto } from './dto/update-lpr-detection-event.dto';
import { UpsertLprDetectionEventDto } from './dto/upsert-lpr-detection-event.dto';
import { LprEventsService } from './lpr-events.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';

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
  @ApiOkResponse({ type: PaginatedLprDetectionEventsDto })
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

  @Patch(':eventId/archive')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary: 'Archive a dismissed LPR detection event after owner review',
    description:
      'Hides a dismissed event from the owner review inbox without deleting the auditable event or its stored evidence image.',
  })
  @ApiOkResponse({ type: LprDetectionEventDto })
  async archive(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    return this.lprEvents.archive(eventId, user);
  }

  @Patch(':eventId/unarchive')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary: 'Move an archived LPR detection event back to owner review',
  })
  @ApiOkResponse({ type: LprDetectionEventDto })
  async unarchive(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    return this.lprEvents.unarchive(eventId, user);
  }

  @Post(':eventId/image')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Upload an LPR detection event's photo",
    description: [
      'Accepts the raw JPEG bytes (`Content-Type: image/jpeg`, max 2MB) captured by the desktop camera service, uploads them to the private `lpr-detection-images` bucket, and persists `imageStoragePath` on the event.',
      '',
      'Object path is deterministic (`<tenantId>/<eventId>.jpg`), so retrying after a dropped connection just overwrites the same object — safe to call again from the offline sync queue.',
    ].join('\n'),
  })
  @ApiConsumes('image/jpeg')
  @ApiBody({
    schema: {
      type: 'string',
      format: 'binary',
      description: 'Raw JPEG bytes captured by the desktop camera service.',
    },
  })
  @ApiOkResponse({ type: LprDetectionEventDto })
  async uploadImage(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Req() req: Request,
  ) {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new FormattedException(
        'Bad Request',
        HttpStatus.BAD_REQUEST,
        'Expected a non-empty body with Content-Type: image/jpeg.',
        req.originalUrl,
        ErrorCodes.BAD_REQUEST,
      );
    }
    return this.lprEvents.uploadImage(eventId, body, 'image/jpeg');
  }

  @Get(':eventId/image-signed-url')
  @ApiOperation({
    summary: "Mint a signed URL to preview an LPR detection event's photo",
    description: [
      'Returns a short-lived signed URL (5 minutes) pointing at the photo binary in Supabase Storage.',
      '',
      "The photo is never exposed via a permanent public URL — it can contain plate and vehicle identity, so URLs are minted on demand with the service role, which bypasses the bucket's deny-by-default storage RLS.",
    ].join('\n'),
  })
  @ApiOkResponse({ type: LprDetectionEventImageSignedUrlDto })
  async imageSignedUrl(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.lprEvents.getImageSignedUrl(eventId);
  }
}
