import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { PaymentTransactionsController } from './payment-transactions.controller';
import { PaymentTransactionsService } from './payment-transactions.service';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentTransactionsController],
  providers: [PaymentTransactionsService],
  exports: [PaymentTransactionsService],
})
export class PaymentTransactionsModule {}
