import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { IssueInvoiceDto } from './dto/issue-invoice.dto';
import { InvoiceChangesQueryDto } from './dto/invoice-changes-query.dto';
import { InvoiceChangesResponseDto } from './dto/invoice-changes-response.dto';
import { InvoiceSummaryDto } from './dto/invoice-summary.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@Controller('tenants/:tenantId')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post('entries/:entryId/invoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Emitir (o reintentar) la factura de una estadía cobrada',
    description:
      'Emite a consumidor final, o Factura A con `receiverCuit` si el emisor ' +
      'es Responsable Inscripto. Los problemas de ARCA (caído, rechazo, ' +
      'certificado vencido, receptor que no puede recibir A) NO son errores HTTP: vuelven en ' +
      '`status` y `errorCode` de la factura; el CUIT mal formado sí es 422 ' +
      'ARCA_CUIT_INVALID. Conflictos: INVOICE_ALREADY_ISSUED, ' +
      'INVOICE_IN_PROGRESS, INVOICE_NOT_INVOICEABLE, ARCA_NOT_LINKED.',
  })
  @ApiOkResponse({ type: InvoiceSummaryDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async issue(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @CurrentUser() user: User,
    @Body() dto: IssueInvoiceDto,
  ): Promise<InvoiceSummaryDto> {
    return this.invoicesService.issueForEntry(
      entryId,
      user?.id,
      dto?.receiverCuit,
    );
  }

  @Get('invoices/changes')
  @ApiOperation({ summary: 'Pull incremental invoice changes for sync' })
  @ApiOkResponse({ type: InvoiceChangesResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async pullChanges(
    @Query() query: InvoiceChangesQueryDto,
  ): Promise<InvoiceChangesResponseDto> {
    return this.invoicesService.pullChanges(query);
  }
}
