import {
  Body,
  Controller,
  Delete,
  Get,
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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import type { UserMembership } from '@prisma/client';
import {
  CurrentMembership,
  EntityRole,
} from '../auth/decorators/entity-role.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { ExpectedVersionQueryDto } from '../vehicles/dto/expected-version-query.dto';
import {
  ClientChangesDto,
  ClientChangesQueryDto,
  ClientDto,
  CreateClientDto,
  UpdateClientDto,
} from './dto/client.dto';
import { ClientsService } from './clients.service';

@ApiTags('Clients')
@ApiBearerAuth()
@Controller('tenants/:tenantId/clients')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
export class ClientsController {
  constructor(private readonly service: ClientsService) {}

  private requireOwner(membership: UserMembership | null | undefined): void {
    if (membership?.role === MembershipRole.owner) return;
    throw new FormattedException(
      'Forbidden',
      HttpStatus.FORBIDDEN,
      'Only the parking owner can manage clients.',
      '/clients',
      ErrorCodes.ENTITY_INSUFFICIENT_ROLE,
    );
  }

  @Get()
  @ApiOkResponse({ type: [ClientDto] })
  list() {
    return this.service.list();
  }

  @Get('changes')
  @ApiOkResponse({ type: ClientChangesDto })
  changes(@Query() query: ClientChangesQueryDto) {
    return this.service.changes(query);
  }

  @Post()
  @EntityRole(MembershipRole.owner)
  @ApiCreatedResponse({ type: ClientDto })
  create(
    @Body() input: CreateClientDto,
    @CurrentMembership() membership: UserMembership | null,
  ) {
    this.requireOwner(membership);
    return this.service.create(input);
  }

  @Patch(':id')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: ClientDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ExpectedVersionQueryDto,
    @Body() input: UpdateClientDto,
    @CurrentMembership() membership: UserMembership | null,
  ) {
    this.requireOwner(membership);
    return this.service.update(id, query.expectedVersion, input);
  }

  @Delete(':id')
  @EntityRole(MembershipRole.owner)
  @ApiOkResponse({ type: ClientDto })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ExpectedVersionQueryDto,
    @CurrentMembership() membership: UserMembership | null,
  ) {
    this.requireOwner(membership);
    return this.service.remove(id, query.expectedVersion);
  }
}
