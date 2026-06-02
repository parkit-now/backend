import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';
import { EntitySummaryDto } from './dto/entity-summary.dto';
import { ListMyEntitiesQueryDto } from './dto/list-my-entities-query.dto';
import { TenantsService } from './tenants.service';

@ApiTags('Tenants')
@ApiExtraModels(
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
  EntitySummaryDto,
)
@Controller('tenants')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @ApiOperation({
    operationId: 'tenantsListMine',
    summary: "List the caller's entities (parking lots)",
    description: [
      'Returns the entities (tenants / parking lots) the authenticated caller belongs to, each with the per-entity role (`owner | operator`), ordered by name.',
      '',
      'This powers the lot switcher: the owner panel calls `GET /tenants?role=owner` to list only the lots they manage. Use `GET /tenants/:tenantId` for the full profile of the active lot.',
      '',
      'Admins bypass membership and therefore have no memberships here — they get an empty list.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: EntitySummaryDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Invalid query (e.g. unknown `role`).',
    type: ValidationProblemDetailsDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, malformed, or expired bearer token.',
    type: ProblemDetailsDto,
  })
  listMine(
    @CurrentUser() user: User,
    @Query() query: ListMyEntitiesQueryDto,
  ): Promise<EntitySummaryDto[]> {
    return this.tenants.listMine(user, query.role);
  }
}
