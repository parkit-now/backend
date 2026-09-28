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
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { IssueInvoiceDto } from './dto/issue-invoice.dto';
import {
  InvoiceBatchResponseDto,
  IssueInvoiceBatchDto,
} from './dto/issue-invoice-batch.dto';
import { InvoiceChangesQueryDto } from './dto/invoice-changes-query.dto';
import { InvoiceChangesResponseDto } from './dto/invoice-changes-response.dto';
import { InvoiceSummaryDto } from './dto/invoice-summary.dto';
import {
  InvoiceReceiverDto,
  InvoiceReceiversQueryDto,
} from './dto/invoice-receiver.dto';
import { TaxpayerDto } from './dto/taxpayer.dto';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@Controller('tenants/:tenantId')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly invoicePdfService: InvoicePdfService,
  ) {}

  @Post('entries/:entryId/invoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Emitir (o reintentar) la factura de una estadía cobrada',
    description:
      'Emite a consumidor final o, con `receiverCuit`, identificada con ese ' +
      'CUIT: la letra la decide el padrón (A si el emisor es RI y el receptor ' +
      'RI o monotributista). Los problemas de ARCA (caído, rechazo, ' +
      'certificado vencido, CUIT sin datos en el padrón) NO son errores HTTP: vuelven en ' +
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

  @Get('arca/taxpayers/:cuit')
  @ApiOperation({
    summary: 'Qué factura sale con este CUIT (padrón de ARCA)',
    description:
      'Consulta la constancia de inscripción (caché de 30 días) y devuelve la ' +
      'letra y la razón social, para mostrarlas antes de emitir. ' +
      '`identified: false` = ARCA no tiene datos: la factura va a consumidor ' +
      'final. 422 ARCA_CUIT_INVALID, 409 ARCA_NOT_LINKED, 503 ARCA_UNAVAILABLE, ' +
      '422 ARCA_CERT_NOT_AUTHORIZED (falta asociar la constancia al certificado).',
  })
  @ApiOkResponse({ type: TaxpayerDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  @ApiParam({ name: 'cuit', description: 'Con o sin guiones' })
  async taxpayer(@Param('cuit') cuit: string): Promise<TaxpayerDto> {
    return this.invoicesService.lookupTaxpayer(cuit);
  }

  @Get('invoice-receivers')
  @ApiOperation({
    summary: 'CUIT ya facturados en la playa (sugerencias del cobro)',
  })
  @ApiOkResponse({ type: InvoiceReceiverDto, isArray: true })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async receivers(
    @Query() query: InvoiceReceiversQueryDto,
  ): Promise<InvoiceReceiverDto[]> {
    return this.invoicesService.receiverSuggestions(query.q, query.limit);
  }

  @Post('invoices/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Emitir en lote a consumidor final',
    description:
      'De a una y en orden, con el resultado de cada estadía. Los conflictos ' +
      'de una (ya emitida, no facturable) no cortan el lote. Si ARCA no ' +
      'responde, las que faltan vuelven con ARCA_UNAVAILABLE sin intentarse. ' +
      'Sin ARCA vinculada: 409 ARCA_NOT_LINKED.',
  })
  @ApiOkResponse({ type: InvoiceBatchResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async issueBatch(
    @CurrentUser() user: User,
    @Body() dto: IssueInvoiceBatchDto,
  ): Promise<InvoiceBatchResponseDto> {
    return this.invoicesService.issueBatch(dto.entryIds, user?.id);
  }

  @Get('invoices/:invoiceId/pdf')
  @ApiOperation({
    summary: 'PDF de una factura emitida',
    description:
      'Se genera a demanda con los datos guardados al emitir (la razón ' +
      'social de ese día, no la actual). 409 INVOICE_NOT_ISSUED si todavía ' +
      'no tiene CAE; 503 INVOICE_PDF_FAILED si no se pudo generar.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async pdf(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ): Promise<StreamableFile> {
    const pdf = await this.invoicePdfService.render(invoiceId);
    return new StreamableFile(pdf.content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${pdf.fileName}"`,
      length: pdf.content.length,
    });
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
