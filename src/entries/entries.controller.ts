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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { CloseEntryDto } from './dto/close-entry.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
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

  @Post()
  @ApiOperation({
    summary: 'Register a vehicle entry (client-provided UUIDv7)',
  })
  @ApiOkResponse({ type: EntryDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async create(@Body() dto: CreateEntryDto) {
    return this.entriesService.createEntry(dto);
  }

  @Patch(':entryId')
  @ApiOperation({
    summary:
      'Close an entry (register exit + payment) using optimistic locking',
  })
  @ApiOkResponse({ type: EntryDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async close(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: CloseEntryDto,
  ) {
    return this.entriesService.closeEntry(entryId, query.expectedVersion, dto);
  }
}
