import { ApiProperty } from '@nestjs/swagger';

export class EntryIdsResponseDto {
  @ApiProperty({
    description:
      'Ids of every live entry of the tenant. Soft-deleted rows are excluded on purpose: the desktop client uses this list to prune local rows the server no longer has.',
    type: [String],
  })
  ids: string[];
}
