import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import {
  InvoiceReceiverSuggestionDto,
  InvoiceReceiverSuggestionRequestDto,
} from './dto/invoice-receiver-suggestion.dto';
import { MpInvoiceReceiverService } from './mp-invoice-receiver.service';
import {
  ProblemDetailsDto,
  ValidationProblemDetailsDto,
} from '../utils/exceptions/dto/problem-details.dto';

@ApiTags('Invoices')
@ApiBearerAuth('bearer')
@Controller('tenants/:tenantId/entries/:entryId/invoice')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiParam({ name: 'tenantId', type: String, format: 'uuid' })
@ApiUnauthorizedResponse({ type: ProblemDetailsDto })
@ApiForbiddenResponse({ type: ProblemDetailsDto })
export class MpInvoiceReceiverController {
  constructor(private readonly receivers: MpInvoiceReceiverService) {}

  @Post('receiver-suggestion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'invoiceReceiverSuggestion',
    summary: 'Suggest the verified QR payer CUIT',
  })
  @ApiOkResponse({ type: InvoiceReceiverSuggestionDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiBadRequestResponse({ type: ValidationProblemDetailsDto })
  suggest(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: InvoiceReceiverSuggestionRequestDto,
  ): Promise<InvoiceReceiverSuggestionDto> {
    return this.receivers.suggest(entryId, dto.paymentIntentId);
  }
}
