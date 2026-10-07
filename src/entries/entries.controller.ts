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
import type { User, UserMembership } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentMembership } from '../auth/decorators/entity-role.decorator';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { CloseEntryDto } from './dto/close-entry.dto';
import { DeleteEntryDto } from './dto/delete-entry.dto';
import { DeleteEntryResponseDto } from './dto/delete-entry-response.dto';
import { CloseEntryResponseDto } from './dto/close-entry-response.dto';
import { CorrectEntryDto } from './dto/correct-entry.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { LprEntryDto } from './dto/lpr-entry.dto';
import { EntryChangesQueryDto } from './dto/entry-changes-query.dto';
import { EntryChangesResponseDto } from './dto/entry-changes-response.dto';
import { EntryDto } from './dto/entry.dto';
import { EntriesService } from './entries.service';
import { ExpectedVersionQueryDto } from './dto/expected-version-query.dto';

@ApiTags('Entries')
@Controller('tenants/:tenantId/entries')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class EntriesController {
  constructor(private readonly entriesService: EntriesService) {}

  @Get()
  @ApiOperation({ summary: 'List all entries for the active tenant' })
  @ApiOkResponse({ type: [EntryDto] })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async findAll() {
    return this.entriesService.findAll();
  }

  @Get('changes')
  @ApiOperation({ summary: 'Pull incremental entry changes for offline sync' })
  @ApiOkResponse({ type: EntryChangesResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async pullChanges(@Query() query: EntryChangesQueryDto) {
    return this.entriesService.pullChanges(query);
  }

  @Post('lpr')
  @ApiOperation({
    summary: 'Register a vehicle entry from an LPR detection event',
  })
  @ApiOkResponse({ type: EntryDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async createFromLpr(@Body() dto: LprEntryDto) {
    return this.entriesService.createStayFromLprEvent(dto);
  }

  @Post()
  @ApiOperation({
    summary: 'Register a vehicle entry (client-provided UUIDv7)',
  })
  @ApiOkResponse({ type: EntryDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async create(@Body() dto: CreateEntryDto) {
    return this.entriesService.createEntry(dto);
  }

  @Post(':entryId/delete')
  @ApiOperation({ summary: 'Soft-delete a stay and its payments (owner only)' })
  @ApiOkResponse({ type: DeleteEntryResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async deleteEntry(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: DeleteEntryDto,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.entriesService.deleteEntry(entryId, dto, user, membership);
  }

  @Patch(':entryId/correction')
  @ApiOperation({
    summary:
      'Correct an entry from history using optimistic locking and audit trail',
  })
  @ApiOkResponse({ type: EntryDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async correct(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: CorrectEntryDto,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.entriesService.correctEntry(
      entryId,
      query.expectedVersion,
      dto,
      user,
      membership,
    );
  }

  @Patch(':entryId')
  @ApiOperation({
    summary:
      'Close an entry (register exit + payment) using optimistic locking',
  })
  @ApiOkResponse({ type: CloseEntryResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async close(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: CloseEntryDto,
    @CurrentUser() user: User,
    @CurrentMembership() membership: UserMembership | null | undefined,
  ) {
    return this.entriesService.closeEntry(
      entryId,
      query.expectedVersion,
      dto,
      user,
      membership,
    );
  }
}
