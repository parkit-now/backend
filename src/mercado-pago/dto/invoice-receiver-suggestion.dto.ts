import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class InvoiceReceiverSuggestionRequestDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  paymentIntentId?: string;
}

export class InvoiceReceiverSuggestionDto {
  @ApiProperty({ type: String, nullable: true })
  cuit!: string | null;
}
