import { ApiProperty } from '@nestjs/swagger';
import { CompanyDocumentDto } from '../../../onboarding/dto/onboarding-response.dto';
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
    description: 'Registered legal name of the applicant company.',
    example: 'Estacionamientos del Centro S.A.',
  })
  legalName: string;

  @ApiProperty({
    description: 'Email of the company owner (no display name exists yet).',
    example: 'owner@example.com',
  })
  ownerEmail: string;

  @ApiProperty({
    description: 'Company contact email declared in the application.',
    example: 'contacto@estacionamientos.com',
  })
  email: string;

  @ApiProperty({
    description: 'Argentine tax id (CUIT) of the company.',
    example: '30-71234567-9',
  })
  cuit: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Number of branches declared in the application.',
    example: 2,
  })
  branchCount: number;

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
      'When the owner submitted the application for review (ISO-8601 UTC). `null` while still a draft.',
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
 * company contact data, declared branches, uploaded documents and review
 * outcome. This is what the Ops reviewer opens before deciding.
 */
export class ApplicationDetailDto extends ApplicationDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Company contact phone number. `null` when not provided.',
    example: '+54 11 5555-5555',
  })
  phone: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Company postal address. `null` when not provided.',
    example: 'Av. Corrientes 1234, CABA',
  })
  address: string | null;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Declared branches snapshot captured at submission time. Each entry carries a name, optional address and per-vehicle spot counts; these are materialized as real lots on approval.',
  })
  declaredBranches: unknown[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Reviewer-provided reason set when the application was rejected. `null` unless `status` is `rejected`.',
    example: 'Missing proof of property ownership for branch #2.',
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
    type: [CompanyDocumentDto],
    description: 'Supporting documents uploaded by the applicant.',
  })
  documents: CompanyDocumentDto[];
}
