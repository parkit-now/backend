import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ValidationProblemDetailsDto } from '../utils/exceptions/dto/problem-details.dto';
import { CashSessionChangesQueryDto } from './dto/cash-session-changes-query.dto';
import { CashSessionChangesResponseDto } from './dto/cash-session-changes-response.dto';
import { CashSessionDto } from './dto/cash-session.dto';
import { CloseCashSessionDto } from './dto/close-cash-session.dto';
import { CloseCashSessionResponseDto } from './dto/close-cash-session-response.dto';
import { CreateCashSessionDto } from './dto/create-cash-session.dto';
import { ExpectedVersionQueryDto } from './dto/expected-version-query.dto';
import { ListCashSessionsQueryDto } from './dto/list-cash-sessions-query.dto';
import { UpdateCashSessionDto } from './dto/update-cash-session.dto';
import { CashSessionsService } from './cash-sessions.service';

@ApiTags('Cash Sessions')
@Controller('tenants/:tenantId/cash-sessions')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class CashSessionsController {
  constructor(private readonly cashSessionsService: CashSessionsService) {}

  @Get('changes')
  @ApiOperation({ summary: 'Pull incremental cash session changes for sync' })
  @ApiOkResponse({ type: CashSessionChangesResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async pullChanges(@Query() query: CashSessionChangesQueryDto) {
    return this.cashSessionsService.pullChanges(query);
  }

  @Get('active')
  @ApiOperation({ summary: 'Get the currently open cash session' })
  @ApiOkResponse({ type: CashSessionDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async getActive() {
    const session = await this.cashSessionsService.getActiveSession();
    if (!session) throw new NotFoundException('No active cash session.');
    return session;
  }

  @Get()
  @ApiOperation({
    summary: 'List cash sessions (most recent first)',
    description: [
      'Optionally only the shifts overlapping `[from, to)`: a shift that opened before `from` but was still running at `from` is included.',
      '',
      '**Capped at `limit` (default 100).** It used to return every shift the lot ever had — about a thousand rows a year to fill a picker. Offline clients should keep syncing through `/changes`, which pages by `syncSeq`.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: [CashSessionDto] })
  @ApiBadRequestResponse({
    description:
      '`from` is not before `to`, a date-time lacks an explicit offset, or `limit` is out of range.',
    type: ValidationProblemDetailsDto,
  })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async findAll(@Query() query: ListCashSessionsQueryDto) {
    return this.cashSessionsService.listSessions(query);
  }

  @Post()
  @ApiOperation({ summary: 'Open a new cash session (client-provided UUIDv7)' })
  @ApiOkResponse({ type: CashSessionDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async create(@Body() dto: CreateCashSessionDto) {
    return this.cashSessionsService.createSession(dto);
  }

  @Patch(':sessionId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Close the current session. Optionally open the next one and carry active entries over.',
  })
  @ApiOkResponse({ type: CloseCashSessionResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async close(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: CloseCashSessionDto,
  ) {
    return this.cashSessionsService.closeSession(sessionId, dto);
  }

  @Patch(':sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a cash session using optimistic locking (expectedVersion)',
    description: 'Updates the shift notes of an open or closed session.',
  })
  @ApiOkResponse({ type: CashSessionDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  @ApiParam({ name: 'sessionId', format: 'uuid' })
  async update(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: UpdateCashSessionDto,
  ) {
    return this.cashSessionsService.updateSession(
      sessionId,
      query.expectedVersion,
      dto,
    );
  }
}
