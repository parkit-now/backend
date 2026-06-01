import { ApiProperty } from '@nestjs/swagger';
import type { ApplicationStatus } from '@prisma/client';

/**
 * Public projection of an `OnboardingApplication` for the applicant portal.
 * An application declares ONE entity (parking lot) and cycles
 * `draft` → `pending_review` → `approved`/`rejected`.
 */
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
    type: 'object',
    additionalProperties: true,
    description:
      'Declared entity snapshot: `name`, `address`, `legalName`, `cuit`, `email`, `phone` and spot counts. On approval it is materialized as a real parking lot (tenant).',
  })
  declaredEntity: Record<string, unknown>;

  @ApiProperty({
    description:
      'Number of document metadata records attached to the application.',
    example: 3,
  })
  docsCount: number;

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

/**
 * Metadata of a document attached to an onboarding application.
 */
export class ApplicationDocumentDto {
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
    example: 'applications/3f2504e0/docs/habilitacion.pdf',
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
