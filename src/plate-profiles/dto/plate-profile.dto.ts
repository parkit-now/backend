import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
export { ClientChangesQueryDto as PlateProfileChangesQueryDto } from '../../clients/dto/client.dto';

export class CreatePlateProfileDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
      : value,
  )
  @Matches(/^[A-Z0-9]{1,20}$/)
  plate: string;

  @ApiProperty({ format: 'uuid' }) @IsUUID() mutationId: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Original owner edit time, preserved by offline retries.',
  })
  @IsDateString()
  occurredAt: string;
  // Owner CAS is independent of automatic learning, which can occur offline.
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedVersion: number;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  vehicleBrand?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  vehicleModel?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vehicleTypeId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  rateId?: string | null;
}
export class UpdatePlateProfileDto extends OmitType(CreatePlateProfileDto, [
  'plate',
] as const) {}
export class DeletePlateProfileDto extends OmitType(CreatePlateProfileDto, [
  'plate',
  'vehicleBrand',
  'vehicleModel',
  'vehicleTypeId',
  'color',
  'rateId',
] as const) {}

export class PlateProfileDto {
  @ApiProperty({ format: 'uuid' }) tenantId: string;
  @ApiProperty() plate: string;
  @ApiProperty({ type: String, nullable: true }) vehicleBrand: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleModel: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleTypeId: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleTypeName: string | null;
  @ApiProperty({ type: String, nullable: true }) color: string | null;
  @ApiProperty({ type: String, nullable: true }) rateId: string | null;
  @ApiProperty({ type: String, nullable: true }) rateName: string | null;
  @ApiProperty({ type: String, nullable: true }) lastEntryId: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastEnteredAt: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  learnAfter: string | null;
  @ApiProperty() editVersion: number;
  @ApiProperty() version: number;
  @ApiProperty() syncSeq: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  deletedAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
export class PlateProfileChangesDto {
  @ApiProperty({ type: [PlateProfileDto] }) items: PlateProfileDto[];
  @ApiProperty() maxSeq: number;
}
