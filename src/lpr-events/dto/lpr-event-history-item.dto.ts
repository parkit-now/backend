import { ApiProperty } from '@nestjs/swagger';
import { LprDetectionEventDto } from './lpr-detection-event.dto';
import {
  LPR_EVENT_DIRECTIONS,
  type LprEventDirection,
} from './list-lpr-event-history-query.dto';

/**
 * One row of the owner-facing LPR event history.
 *
 * Carries the full detection record (so the detail view needs no extra fetch)
 * plus three read helpers the auditing UI needs directly: the best plate
 * string, the derived movement direction and whether an evidence image is
 * still available. The full-resolution photo is loaded separately through
 * `GET /tenants/:tenantId/lpr-events/:eventId/image-signed-url`.
 */
export class LprEventHistoryItemDto extends LprDetectionEventDto {
  @ApiProperty({
    enum: LPR_EVENT_DIRECTIONS,
    description: 'Movement direction derived from the camera `location`.',
  })
  direction: LprEventDirection;

  @ApiProperty({
    nullable: true,
    description:
      'Best available plate string: `displayPlate`, else `normalizedText`, else `rawText`.',
  })
  plate: string | null;

  @ApiProperty({
    description:
      'True when the event still has an evidence image (`imageStoragePath` set and not purged by the retention job).',
  })
  hasImage: boolean;
}
