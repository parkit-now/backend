import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiTags,
  ApiParam,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { TableTemplatesService } from './table-templates.service';
import {
  SaveTableTemplateDto,
  TableTemplateDto,
  TableTemplateQueryDto,
  TableTemplateMutationDto,
} from './table-templates.dto';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsUUID,
} from 'class-validator';

class TemplateIdDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  id!: string;
}
@ApiTags('Table templates')
@ApiBearerAuth('bearer')
@ApiExtraModels(TableTemplateDto)
@Controller('tenants/:tenantId/table-templates')
@ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
export class TableTemplatesController {
  constructor(protected readonly templates: TableTemplatesService) {}
  protected admin = false;

  @Get()
  @ApiOkResponse({ type: TableTemplateDto, isArray: true })
  list(@CurrentUser() user: User, @Query() query: TableTemplateQueryDto) {
    return this.templates.list(user.id, query, this.admin);
  }
  @Put(':id')
  @ApiParam({ name: 'id', type: String })
  @ApiOkResponse({ type: TableTemplateDto })
  save(
    @CurrentUser() user: User,
    @Query() query: TableTemplateQueryDto,
    @Param() params: TemplateIdDto,
    @Body() body: SaveTableTemplateDto,
  ) {
    return this.templates.mutate(
      user.id,
      query,
      params.id,
      body.mutationId,
      body,
      false,
      this.admin,
    );
  }
  @Post('import/:id')
  @ApiParam({ name: 'id', type: String })
  @HttpCode(200)
  @ApiOkResponse({ type: TableTemplateDto })
  import(
    @CurrentUser() user: User,
    @Query() query: TableTemplateQueryDto,
    @Param() params: TemplateIdDto,
    @Body() body: SaveTableTemplateDto,
  ) {
    return this.templates.mutate(
      user.id,
      query,
      params.id,
      body.mutationId,
      body,
      true,
      this.admin,
    );
  }
  @Delete(':id')
  @ApiParam({ name: 'id', type: String })
  @ApiOkResponse({ type: TableTemplateDto })
  remove(
    @CurrentUser() user: User,
    @Query() query: TableTemplateQueryDto,
    @Param() params: TemplateIdDto,
    @Body() body: TableTemplateMutationDto,
  ) {
    return this.templates.mutate(
      user.id,
      query,
      params.id,
      body.mutationId,
      undefined,
      false,
      this.admin,
    );
  }
}
@ApiTags('Table templates')
@ApiBearerAuth('bearer')
@Controller('admin/table-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class AdminTableTemplatesController {
  constructor(private readonly templates: TableTemplatesService) {}
  @Get()
  @ApiOkResponse({ type: TableTemplateDto, isArray: true })
  list(@CurrentUser() user: User, @Query() query: TableTemplateQueryDto) {
    return this.templates.list(user.id, query, true);
  }
  @Put(':id')
  @ApiParam({ name: 'id', type: String })
  @ApiOkResponse({ type: TableTemplateDto })
  save(
    @CurrentUser() user: User,
    @Query() query: TableTemplateQueryDto,
    @Param() params: TemplateIdDto,
    @Body() body: SaveTableTemplateDto,
  ) {
    return this.templates.mutate(
      user.id,
      query,
      params.id,
      body.mutationId,
      body,
      false,
      true,
    );
  }
  @Post('import/:id')
  @ApiParam({ name: 'id', type: String })
  @HttpCode(200)
  @ApiOkResponse({ type: TableTemplateDto })
  import(
    @CurrentUser() user: User,
    @Query() query: TableTemplateQueryDto,
    @Param() params: TemplateIdDto,
    @Body() body: SaveTableTemplateDto,
  ) {
    return this.templates.mutate(
      user.id,
      query,
      params.id,
      body.mutationId,
      body,
      true,
      true,
    );
  }
  @Delete(':id')
  @ApiParam({ name: 'id', type: String })
  @ApiOkResponse({ type: TableTemplateDto })
  remove(
    @CurrentUser() user: User,
    @Query() query: TableTemplateQueryDto,
    @Param() params: TemplateIdDto,
    @Body() body: TableTemplateMutationDto,
  ) {
    return this.templates.mutate(
      user.id,
      query,
      params.id,
      body.mutationId,
      undefined,
      false,
      true,
    );
  }
}
