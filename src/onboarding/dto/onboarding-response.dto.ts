import { ApiProperty } from '@nestjs/swagger';
import type { ApplicationStatus } from '@prisma/client';
import { CompanyProfileDto } from './company-profile.dto';

export class OnboardingApplicationDto {
  @ApiProperty({
    description: 'Onboarding application id (UUID).',
    format: 'uuid',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  })
  id: string;

  @ApiProperty({
    description:
      'Lifecycle state of the application. Flows `draft` → `pending_review` → `approved`/`rejected`; `rejected` can be edited and resubmitted.',
    enum: ['draft', 'pending_review', 'approved', 'rejected'],
    example: 'draft',
  })
  status: ApplicationStatus;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Declared branches snapshot (before approval). Each entry carries `name`, optional `address`, and spot counts (`carSpots`/`motorcycleSpots`/`bicycleSpots`). On approval each becomes a real lot.',
  })
  declaredBranches: unknown[];

  @ApiProperty({
    description: 'Number of declared branches in this application.',
    example: 2,
  })
  declaredBranchCount: number;

  @ApiProperty({
    description: 'Number of document metadata records attached to the company.',
    example: 3,
  })
  docsCount: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'ISO-8601 UTC timestamp of the last submission, or `null` while still in `draft` and never submitted.',
    example: '2026-05-20T14:32:00.000Z',
  })
  submittedAt: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'ISO-8601 UTC timestamp of the PARKIT Ops review, or `null` if not yet reviewed.',
    example: '2026-05-21T09:10:00.000Z',
  })
  reviewedAt: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Reason provided by PARKIT Ops when the application was rejected, or `null` otherwise.',
    example: 'CUIT does not match the declared legal name.',
  })
  rejectionReason: string | null;

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp of creation.',
    example: '2026-05-19T11:00:00.000Z',
  })
  createdAt: string;
}

export class OnboardingStateDto {
  @ApiProperty({
    type: CompanyProfileDto,
    nullable: true,
    description:
      'The company owned by the caller, or `null` when onboarding has not started.',
  })
  company: CompanyProfileDto | null;

  @ApiProperty({
    type: OnboardingApplicationDto,
    nullable: true,
    description:
      'The latest onboarding application of the company, or `null` when none exists.',
  })
  application: OnboardingApplicationDto | null;
}

export class CompanyDocumentDto {
  @ApiProperty({
    description: 'Document metadata record id (UUID).',
    format: 'uuid',
    example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  })
  id: string;

  @ApiProperty({
    description: 'Human-readable document name.',
    example: 'Habilitacion municipal.pdf',
  })
  name: string;

  @ApiProperty({
    description: 'Object key of the binary in Supabase Storage.',
    example: 'companies/3f2504e0/docs/habilitacion.pdf',
  })
  storagePath: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'MIME type of the document, or `null` if not provided.',
    example: 'application/pdf',
  })
  mimeType: string | null;

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp of creation.',
    example: '2026-05-19T11:05:00.000Z',
  })
  createdAt: string;
}
