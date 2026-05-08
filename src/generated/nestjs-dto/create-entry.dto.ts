import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDecimal,
  IsNotEmpty,
  IsOptional,
  IsRFC3339,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { ConnectVehicleDto } from './connect-vehicle.dto';

export class CreateEntryVehicleRelationInputDto {
  connect: ConnectVehicleDto;
}

@ApiExtraModels(ConnectVehicleDto, CreateEntryVehicleRelationInputDto)
export class CreateEntryDto {
  @IsNotEmpty()
  @IsString()
  plate: string;
  @IsOptional()
  @IsString()
  color?: string;
  @ApiProperty({
    type: `string`,
    format: `date-time`,
  })
  @IsOptional()
  @IsRFC3339()
  leftAt?: Date;
  @ApiProperty({
    type: `number`,
    format: `double`,
  })
  @IsOptional()
  @IsDecimal()
  @Type(() => String)
  amountPaid?: Prisma.Decimal;
  @IsNotEmpty()
  @ValidateNested()
  @Type(() => CreateEntryVehicleRelationInputDto)
  vehicle: CreateEntryVehicleRelationInputDto;
}
