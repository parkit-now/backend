import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { EntriesService } from './entries.service';
import { CreateEntryDto } from '../generated/nestjs-dto/create-entry.dto';

@ApiTags('Entries')
// Las rutas deben depender del tenant
@Controller('tenants/:tenantId/entries')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class EntriesController {
  constructor(private readonly entriesService: EntriesService) {}

  @Post()
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async create(@Body() dto: CreateEntryDto): Promise<any> {
    return await this.entriesService.createEntry(dto);
  }

  @Get()
  @ApiParam({
    name: 'tenantId',
    description: 'The ID of the tenant (parking lot)',
  })
  async findAll(): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await this.entriesService.findAll();
  }
}
