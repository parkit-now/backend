import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { MembershipRole } from '@prisma/client';
import { EntityRole } from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ServiceCatalogItemDto } from './dto/service-catalog-item.dto';
import { ServiceChangesQueryDto } from './dto/service-changes-query.dto';
import { ServiceChangesResponseDto } from './dto/service-changes-response.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ServicesService } from './services.service';

@ApiTags('Services')
@Controller('tenants/:tenantId/services')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the service catalog with the tenant enabled state',
  })
  @ApiOkResponse({ type: [ServiceCatalogItemDto] })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async findAll() {
    return this.servicesService.listServices();
  }

  @Get('changes')
  @ApiOperation({ summary: 'Pull incremental changes for offline sync' })
  @ApiOkResponse({ type: ServiceChangesResponseDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async pullChanges(@Query() query: ServiceChangesQueryDto) {
    return this.servicesService.pullChanges(query);
  }

  @Patch(':code')
  @EntityRole(MembershipRole.owner)
  @ApiOperation({
    summary: 'Update a service for the active tenant (enabled and/or spots)',
  })
  @ApiOkResponse({ type: ServiceCatalogItemDto })
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  @ApiParam({ name: 'code', description: 'Service code (ServiceCode enum)' })
  async update(@Param('code') code: string, @Body() dto: UpdateServiceDto) {
    return this.servicesService.updateService(code, {
      enabled: dto.enabled,
      spots: dto.spots,
    });
  }
}
