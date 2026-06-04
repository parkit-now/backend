import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class CreatePaymentMethodDto {
  @ApiProperty({ example: 'Naranja X', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;
}
