import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export function normalizeClientPlate(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export class CreateClientDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;

  @ApiProperty({ type: [String], example: ['IAG574'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) =>
          typeof item === 'string' ? normalizeClientPlate(item) : item,
        )
      : value,
  )
  @Matches(/^[A-Z0-9]{1,20}$/, { each: true })
  plates: string[];

  @ApiPropertyOptional({ type: String, nullable: true, example: '20427205208' })
  @IsOptional()
  @IsString()
  cuit?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 254 })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @ApiPropertyOptional({
    description: 'Confirm moving plates belonging to other clients.',
  })
  @IsOptional()
  @IsBoolean()
  movePlates?: boolean;

  @ApiPropertyOptional({
    description: 'Name came from an ARCA lookup, not an owner edit.',
  })
  @IsOptional()
  @IsBoolean()
  nameIsAutomatic?: boolean;
}

export class UpdateClientDto extends PartialType(
  OmitType(CreateClientDto, ['id'] as const),
  { skipNullProperties: false },
) {}

export class ClientDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) tenantId: string;
  @ApiProperty({ type: [String] }) plates: string[];
  @ApiProperty({ type: String, nullable: true }) cuit: string | null;
  @ApiProperty({ type: String, nullable: true }) name: string | null;
  @ApiProperty({ type: String, nullable: true }) email: string | null;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty() version: number;
  @ApiProperty() syncSeq: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  deletedAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class ClientChangesDto {
  @ApiProperty({ type: [ClientDto] }) items: ClientDto[];
  @ApiProperty() maxSeq: number;
}

export class ClientChangesQueryDto {
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq = 0;

  @ApiPropertyOptional({ default: 1000, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 1000;
}
