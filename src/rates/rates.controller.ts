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
import { CreateRateDto } from './dto/create-rate.dto';
import { ExpectedVersionQueryDto } from './dto/expected-version-query.dto';
import { ListRatesQueryDto } from './dto/list-rates-query.dto';
import { RateChangesQueryDto } from './dto/rate-changes-query.dto';
import { RateChangesResponseDto } from './dto/rate-changes-response.dto';
import { RateDto } from './dto/rate.dto';
import { UpdateRateDto } from './dto/update-rate.dto';
import { RatesService } from './rates.service';

@ApiTags('Rates')
@Controller('tenants/:tenantId/rates')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class RatesController {
  constructor(private readonly ratesService: RatesService) {}

  @Get()
  @ApiOperation({ summary: 'List rates in the active tenant' })
  @ApiOkResponse({ type: [RateDto] })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async findAll(@Query() query: ListRatesQueryDto) {
    return this.ratesService.listRates(query);
  }

  @Get('changes')
  @ApiOperation({ summary: 'Pull incremental changes for offline sync' })
  @ApiOkResponse({ type: RateChangesResponseDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async pullChanges(@Query() query: RateChangesQueryDto) {
    return this.ratesService.pullChanges(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @ApiOperation({ summary: 'Create a new rate in the active tenant' })
  @ApiOkResponse({ type: RateDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async create(@Body() dto: CreateRateDto) {
    return this.ratesService.createRate(dto);
  }

  @Patch(':rateId')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary: 'Update a rate using optimistic locking (expectedVersion)',
  })
  @ApiOkResponse({ type: RateDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async update(
    @Param('rateId', ParseUUIDPipe) rateId: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() dto: UpdateRateDto,
  ) {
    return this.ratesService.updateRate(rateId, query.expectedVersion, dto);
  }

  @Delete(':rateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary: 'Soft-delete a rate using optimistic locking (expectedVersion)',
    description:
      'Soft-deletes the rate (sets deleted_at). The row keeps flowing through ' +
      'GET /rates/changes as a tombstone so offline clients can remove it ' +
      'from their local copy. Requires owner role.',
  })
  @ApiNoContentResponse({ description: 'Rate deleted successfully' })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async remove(
    @Param('rateId', ParseUUIDPipe) rateId: string,
    @Query() query: ExpectedVersionQueryDto,
  ) {
    return this.ratesService.deleteRate(rateId, query.expectedVersion);
  }
}
