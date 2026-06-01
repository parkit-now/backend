import { ApiProperty } from '@nestjs/swagger';
import type { CompanyStatus } from '@prisma/client';

/**
 * Public profile of a company. Shared by onboarding and companies.
 */
export class CompanyProfileDto {
  @ApiProperty({
    description: 'Company id (UUID).',
    format: 'uuid',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  id: string;

  @ApiProperty({
    description: 'Registered legal name of the entity.',
    example: 'Estacionamientos del Centro S.A.',
  })
  legalName: string;

  @ApiProperty({
    description: 'CUIT (Argentine tax id), 11 digits.',
    example: '30123456789',
  })
  cuit: string;

  @ApiProperty({
    description: 'Contact email of the company.',
    format: 'email',
    example: 'contacto@estacionamiento.com',
  })
  email: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Contact phone, or `null` if not provided.',
    example: '+541145678900',
  })
  phone: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Legal address, or `null` if not provided.',
    example: 'Av. Corrientes 1234, CABA',
  })
  address: string | null;

  @ApiProperty({
    description:
      'Company status. Starts as `pending` during onboarding; becomes `active` once approved.',
    enum: ['pending', 'active', 'suspended'],
    example: 'pending',
  })
  status: CompanyStatus;

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp of creation.',
    example: '2026-05-19T11:00:00.000Z',
  })
  createdAt: string;
}
