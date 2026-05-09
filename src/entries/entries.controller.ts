import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { EntriesService } from './entries.service';
import { CreateEntryDto } from '../generated/nestjs-dto/create-entry.dto';

@ApiTags('Entries')
// Las rutas deben depender del tenant
@Controller('tenants/:tenantId/entries')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@ApiBearerAuth('bearer')
export class EntriesController {
  constructor(private readonly entriesService: EntriesService) {}

  @Post()
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateEntryDto,
  ) {
    return this.entriesService.createEntryForTenant(tenantId, dto);
  }

  @Get()
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async findAll(@Param('tenantId') tenantId: string) {
    return this.entriesService.findAllForTenant(tenantId);
  }
}
