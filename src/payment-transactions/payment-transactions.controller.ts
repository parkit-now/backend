import {
  Controller,
  Get,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../auth/guards/tenant-membership.guard';
import { TenantInterceptor } from '../database/tenant.interceptor';
import { PaymentTransactionChangesQueryDto } from './dto/payment-transaction-changes-query.dto';
import { PaymentTransactionChangesResponseDto } from './dto/payment-transaction-changes-response.dto';
import { PaymentTransactionsService } from './payment-transactions.service';

@ApiTags('Payment Transactions')
@Controller('tenants/:tenantId/payment-transactions')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
@UseInterceptors(TenantInterceptor)
@ApiBearerAuth('bearer')
export class PaymentTransactionsController {
  constructor(
    private readonly paymentTransactionsService: PaymentTransactionsService,
  ) {}

  @Get('changes')
  @ApiOperation({
    summary: 'Pull incremental payment transaction changes for sync',
  })
  @ApiOkResponse({ type: PaymentTransactionChangesResponseDto })
  @ApiParam({ name: 'tenantId', description: 'Parking lot tenant ID' })
  async pullChanges(@Query() query: PaymentTransactionChangesQueryDto) {
    return this.paymentTransactionsService.pullChanges(query);
  }
}
