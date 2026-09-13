import { ApiProperty } from '@nestjs/swagger';
import { EntityAddressDto } from '../../../entities/dto/entity-address.dto';
import { ApplicationDocumentDto } from '../../../onboarding/dto/onboarding-response.dto';
import type { ApplicationStatusFilter } from './list-applications-query.dto';

/**
 * Denormalized view of an application for the PARKIT Ops queue.
 * `status` maps the internal `application_status` to the front contract
 * (`pending_review` → `pending`).
 */
export class ApplicationDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Onboarding application id.',
    example: '3f1d2c4b-5e6a-7b8c-9d0e-1f2a3b4c5d6e',
  })
  id: string;

  @ApiProperty({
    description: 'Declared display name of the parking lot.',
    example: 'Estacionamiento del Centro',
  })
  name: string;

  @ApiProperty({
    description: 'Declared legal name of the entity.',
    example: 'Estacionamientos del Centro S.A.',
  })
  legalName: string;

  @ApiProperty({
    description: 'Email of the applicant user (no display name exists yet).',
    example: 'applicant@example.com',
  })
  applicantEmail: string;

  @ApiProperty({
    description: 'Declared contact email of the entity.',
    example: 'contacto@estacionamiento.com',
  })
  email: string;

  @ApiProperty({
    description: 'Declared Argentine tax id (CUIT).',
    example: '30712345679',
  })
  cuit: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Number of supporting documents uploaded by the applicant.',
    example: 3,
  })
  docsCount: number;

  @ApiProperty({
    enum: ['pending', 'approved', 'rejected'],
    description:
      'External review status. The internal `pending_review` state surfaces as `pending`; drafts never appear in the queue.',
    example: 'pending',
  })
  status: ApplicationStatusFilter;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'When the applicant submitted the application for review (ISO-8601 UTC). `null` while still a draft.',
    example: '2026-05-20T14:30:00.000Z',
  })
  submittedAt: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When the application record was created (ISO-8601 UTC).',
    example: '2026-05-18T09:15:00.000Z',
  })
  createdAt: string;
}

/**
 * Full review detail for a single application: the summary fields plus the
 * declared entity data, uploaded documents and review outcome.
 */
export class ApplicationDetailDto extends ApplicationDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Declared contact phone number. `null` when not provided.',
    example: '+54 11 5555-5555',
  })
  phone: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Dirección declarada en una línea. Sale de `location.formatted`. `null` si no se declaró.',
    example: 'Av. Corrientes 1234, CABA',
  })
  address: string | null;

  @ApiProperty({
    type: EntityAddressDto,
    description:
      'Dirección estructurada declarada, tal como se va a materializar en `tenants` al aprobar. Los borradores anteriores al wizard nuevo sólo traen `formatted`; el resto de los campos viene en `null`.',
  })
  location: EntityAddressDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Declared entity snapshot captured at submission time (name, address, legal data and per-vehicle spot counts). Materialized as a real parking lot on approval.',
  })
  declaredEntity: Record<string, unknown>;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'Id of the entity (tenant) created on approval, or `null` until approved.',
    example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  })
  tenantId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Reviewer-provided reason set when the application was rejected. `null` unless `status` is `rejected`.',
    example: 'Missing proof of property ownership.',
  })
  rejectionReason: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'When an Ops reviewer approved or rejected the application (ISO-8601 UTC). `null` while still pending.',
    example: '2026-05-21T10:00:00.000Z',
  })
  reviewedAt: string | null;

  @ApiProperty({
    type: [ApplicationDocumentDto],
    description: 'Supporting documents uploaded by the applicant.',
  })
  documents: ApplicationDocumentDto[];
}
