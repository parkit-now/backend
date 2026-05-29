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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
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
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
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
  @Roles(UserRole.owner, UserRole.admin)
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
  @Roles(UserRole.owner, UserRole.admin)
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
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({
    summary: 'Soft delete a rate using optimistic locking (expectedVersion)',
  })
  @ApiOkResponse({ type: RateDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async remove(
    @Param('rateId', ParseUUIDPipe) rateId: string,
    @Query() query: ExpectedVersionQueryDto,
  ) {
    return this.ratesService.deactivateRate(rateId, query.expectedVersion);
  }
}
